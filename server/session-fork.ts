import fs from 'fs'
import os from 'os'
import path from 'path'

// Lossless conversation fork: copy the provider's own native session file,
// truncated strictly before the fork-point user turn, under a fresh session id.
// The forked card then resumes through the provider's normal native resume path
// (`claude -r` / `codex exec resume`) with full pre-fork context. Anything that
// cannot be mapped confidently returns null so the caller falls back to the
// existing seeded-transcript replay instead of guessing.

export type SessionForkPoint = {
  content: string
  createdAtMs?: number | null
}

export type ForkProviderSessionOptions = {
  provider: 'claude' | 'codex'
  workspacePath: string
  sessionId: string
  forkPoint: { content: string; createdAt?: string | null }
}

// A containment match this far away from the UI message timestamp is more
// likely a coincidental repeat than the actual fork-point turn.
const matchToleranceMs = 10 * 60_000
// Attachment-only fork points have no text to anchor on; allow small clock skew
// between the renderer timestamp and the CLI transcript timestamp.
const emptyContentSkewMs = 5_000

const externalHistoryHomeEnvKey = 'CHILL_VIBE_EXTERNAL_HISTORY_HOME'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const tryParseJson = (line: string): unknown | null => {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

const parseTimestampMs = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

type UserTurnCandidate = {
  lineIndex: number
  text: string
  timestampMs: number | null
}

// Synthetic user-role entries Codex injects around real prompts.
const syntheticCodexUserTextPattern =
  /^<(environment_context|user_instructions|permissions|turn_context|collaboration_mode)[\s>]/

const collectTextBlocks = (content: unknown, textKey: string): string | null => {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  const texts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) {
      continue
    }
    if (block.type === 'tool_result') {
      // Tool results ride on user-role entries but are not user turns.
      return null
    }
    if (block.type === textKey && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }

  return texts.length > 0 ? texts.join('\n') : null
}

const getClaudeUserTurn = (entry: unknown): { text: string; timestampMs: number | null } | null => {
  if (!isRecord(entry) || entry.type !== 'user' || entry.isSidechain === true) {
    return null
  }
  if ('attachment' in entry) {
    return null
  }
  const message = entry.message
  if (!isRecord(message) || message.role !== 'user') {
    return null
  }
  const text = collectTextBlocks(message.content, 'text')
  if (text === null) {
    return null
  }
  return { text, timestampMs: parseTimestampMs(entry.timestamp) }
}

const getCodexUserTurn = (entry: unknown): { text: string; timestampMs: number | null } | null => {
  if (!isRecord(entry) || entry.type !== 'response_item') {
    return null
  }
  const payload = entry.payload
  if (!isRecord(payload) || payload.type !== 'message' || payload.role !== 'user') {
    return null
  }
  const text = collectTextBlocks(payload.content, 'input_text')
  if (text === null || syntheticCodexUserTextPattern.test(text.trimStart())) {
    return null
  }
  return { text, timestampMs: parseTimestampMs(entry.timestamp) }
}

const splitSourceLines = (sourceContent: string) => {
  const lines = sourceContent.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
    lines.pop()
  }
  return lines
}

const findForkCutIndex = (
  candidates: UserTurnCandidate[],
  forkPoint: SessionForkPoint,
): number | null => {
  const wantedText = forkPoint.content.trim()
  const createdAtMs = forkPoint.createdAtMs ?? null

  if (wantedText.length > 0) {
    const matches = candidates.filter((candidate) => candidate.text.includes(wantedText))
    if (matches.length === 0) {
      return null
    }

    if (createdAtMs === null) {
      return matches.length === 1 ? matches[0]!.lineIndex : null
    }

    let best: UserTurnCandidate | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of matches) {
      const distance =
        candidate.timestampMs === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(candidate.timestampMs - createdAtMs)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }

    if (!best) {
      return null
    }
    if (bestDistance !== Number.POSITIVE_INFINITY && bestDistance > matchToleranceMs) {
      return null
    }
    if (bestDistance === Number.POSITIVE_INFINITY && matches.length > 1) {
      return null
    }
    return best.lineIndex
  }

  if (createdAtMs === null) {
    return null
  }

  for (const candidate of candidates) {
    if (candidate.timestampMs !== null && candidate.timestampMs >= createdAtMs - emptyContentSkewMs) {
      return candidate.lineIndex
    }
  }
  return null
}

type PlanOptions = {
  newSessionId: string
  forkPoint: SessionForkPoint
}

// The CLI writes turn-intake companions BEFORE the user entry of a new turn:
// Claude emits queue-operation lines (carrying the prompt text), an
// `isMeta: true` filler user entry, and a `<synthetic>` assistant entry; Codex
// emits `turn_context` and `event_msg` lines. Cutting at the fork-point user
// entry would keep those dangling at the fork tail, leaking the fork-point
// prompt into the forked context.
const isClaudeTurnBoundaryResidue = (entry: unknown) => {
  if (!isRecord(entry)) {
    return false
  }
  if (entry.type === 'queue-operation') {
    return true
  }
  if (entry.isMeta === true) {
    return true
  }
  if (entry.type === 'assistant' && isRecord(entry.message) && entry.message.model === '<synthetic>') {
    return true
  }
  return false
}

const isCodexTurnBoundaryResidue = (entry: unknown) =>
  isRecord(entry) && (entry.type === 'turn_context' || entry.type === 'event_msg')

const collectDuplicateDeliveryIndexes = (
  candidates: UserTurnCandidate[],
  forkPoint: SessionForkPoint,
) => {
  const wantedText = forkPoint.content.trim()
  if (!wantedText) {
    return new Set<number>()
  }
  return new Set(
    candidates
      .filter((candidate) => candidate.text.includes(wantedText))
      .map((candidate) => candidate.lineIndex),
  )
}

const trimTrailingResidue = (
  cutIndex: number,
  parsed: (unknown | null)[],
  isResidue: (entry: unknown) => boolean,
  isDuplicateDelivery: (lineIndex: number) => boolean,
) => {
  let end = cutIndex
  // CLI-level retries re-deliver the same prompt several times, so the cut
  // must also swallow earlier duplicate deliveries of the fork-point turn
  // (they are only separated from the matched one by boundary residue).
  while (end > 0 && (isResidue(parsed[end - 1]) || isDuplicateDelivery(end - 1))) {
    end -= 1
  }
  return end
}

export const planClaudeSessionFork = (
  sourceContent: string,
  options: PlanOptions,
): string | null => {
  const lines = splitSourceLines(sourceContent)
  const parsed = lines.map((line) => tryParseJson(line))

  const candidates: UserTurnCandidate[] = []
  parsed.forEach((entry, lineIndex) => {
    const turn = getClaudeUserTurn(entry)
    if (turn) {
      candidates.push({ lineIndex, ...turn })
    }
  })

  const matchedIndex = findForkCutIndex(candidates, options.forkPoint)
  if (matchedIndex === null) {
    return null
  }
  const duplicateDeliveryIndexes = collectDuplicateDeliveryIndexes(candidates, options.forkPoint)
  const cutIndex = trimTrailingResidue(matchedIndex, parsed, isClaudeTurnBoundaryResidue, (index) =>
    duplicateDeliveryIndexes.has(index),
  )

  // A fork whose native context holds no earlier user turn carries nothing
  // worth resuming; let the caller fall back to a plain fresh session.
  if (!candidates.some((candidate) => candidate.lineIndex < cutIndex)) {
    return null
  }

  const keptLines = lines.slice(0, cutIndex).map((line, lineIndex) => {
    const entry = parsed[lineIndex]
    if (!isRecord(entry) || typeof entry.sessionId !== 'string') {
      return line
    }
    return JSON.stringify({ ...entry, sessionId: options.newSessionId })
  })

  return `${keptLines.join('\n')}\n`
}

export const planCodexSessionFork = (
  sourceContent: string,
  options: PlanOptions,
): string | null => {
  const lines = splitSourceLines(sourceContent)
  const parsed = lines.map((line) => tryParseJson(line))

  const metaIndex = parsed.findIndex(
    (entry) => isRecord(entry) && entry.type === 'session_meta' && isRecord(entry.payload),
  )
  if (metaIndex < 0) {
    return null
  }

  const candidates: UserTurnCandidate[] = []
  parsed.forEach((entry, lineIndex) => {
    const turn = getCodexUserTurn(entry)
    if (turn) {
      candidates.push({ lineIndex, ...turn })
    }
  })

  const matchedIndex = findForkCutIndex(candidates, options.forkPoint)
  if (matchedIndex === null || matchedIndex <= metaIndex) {
    return null
  }
  const duplicateDeliveryIndexes = collectDuplicateDeliveryIndexes(candidates, options.forkPoint)
  const cutIndex = trimTrailingResidue(matchedIndex, parsed, isCodexTurnBoundaryResidue, (index) =>
    duplicateDeliveryIndexes.has(index),
  )
  if (cutIndex <= metaIndex) {
    return null
  }

  if (!candidates.some((candidate) => candidate.lineIndex < cutIndex)) {
    return null
  }

  const keptLines = lines.slice(0, cutIndex).map((line, lineIndex) => {
    if (lineIndex !== metaIndex) {
      return line
    }
    const meta = parsed[metaIndex] as Record<string, unknown>
    const payload = meta.payload as Record<string, unknown>
    return JSON.stringify({ ...meta, payload: { ...payload, id: options.newSessionId } })
  })

  return `${keptLines.join('\n')}\n`
}

const resolveConfiguredPath = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized ? path.resolve(normalized) : null
}

const resolveHomeDirs = () => {
  const configured = process.env[externalHistoryHomeEnvKey]?.trim()
  if (configured) {
    return [path.resolve(configured)]
  }

  const candidates = [
    resolveConfiguredPath(process.env.HOME),
    resolveConfiguredPath(process.env.USERPROFILE),
    resolveConfiguredPath(
      process.env.HOMEDRIVE && process.env.HOMEPATH
        ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
        : undefined,
    ),
    resolveConfiguredPath(os.homedir()),
  ]

  const unique = new Set<string>()
  for (const candidate of candidates) {
    if (candidate) {
      unique.add(candidate)
    }
  }
  return Array.from(unique)
}

const listSubdirectories = (dirPath: string) => {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dirPath, entry.name))
  } catch {
    return []
  }
}

// Locate `<sessionId>.jsonl` by scanning project dirs instead of deriving the
// cwd slug: slug rules have drifted between CLI versions and a scan can never
// pick the wrong directory for an exact session-id filename.
const findClaudeSessionFile = (sessionId: string) => {
  for (const homeDir of resolveHomeDirs()) {
    const projectsDir = path.join(homeDir, '.claude', 'projects')
    for (const projectDir of listSubdirectories(projectsDir)) {
      const candidate = path.join(projectDir, `${sessionId}.jsonl`)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

const findCodexRolloutFile = (sessionId: string) => {
  for (const homeDir of resolveHomeDirs()) {
    const sessionsDir = path.join(homeDir, '.codex', 'sessions')
    for (const yearDir of listSubdirectories(sessionsDir)) {
      for (const monthDir of listSubdirectories(yearDir)) {
        for (const dayDir of listSubdirectories(monthDir)) {
          let entries: string[]
          try {
            entries = fs.readdirSync(dayDir)
          } catch {
            continue
          }
          const match = entries.find(
            (name) => name.endsWith(`-${sessionId}.jsonl`) && name.startsWith('rollout-'),
          )
          if (match) {
            return path.join(dayDir, match)
          }
        }
      }
    }
  }
  return null
}

export const forkProviderSession = async (
  options: ForkProviderSessionOptions,
): Promise<string | null> => {
  try {
    const forkPoint: SessionForkPoint = {
      content: options.forkPoint.content,
      createdAtMs: parseTimestampMs(options.forkPoint.createdAt ?? undefined),
    }
    const newSessionId = crypto.randomUUID()

    if (options.provider === 'claude') {
      const sourcePath = findClaudeSessionFile(options.sessionId)
      if (!sourcePath) {
        return null
      }
      const plan = planClaudeSessionFork(await fs.promises.readFile(sourcePath, 'utf8'), {
        newSessionId,
        forkPoint,
      })
      if (!plan) {
        return null
      }
      await fs.promises.writeFile(
        path.join(path.dirname(sourcePath), `${newSessionId}.jsonl`),
        plan,
        'utf8',
      )
      return newSessionId
    }

    const sourcePath = findCodexRolloutFile(options.sessionId)
    if (!sourcePath) {
      return null
    }
    const plan = planCodexSessionFork(await fs.promises.readFile(sourcePath, 'utf8'), {
      newSessionId,
      forkPoint,
    })
    if (!plan) {
      return null
    }
    const forkedName = path.basename(sourcePath).replace(`-${options.sessionId}.jsonl`, `-${newSessionId}.jsonl`)
    if (forkedName === path.basename(sourcePath)) {
      return null
    }
    await fs.promises.writeFile(path.join(path.dirname(sourcePath), forkedName), plan, 'utf8')
    return newSessionId
  } catch {
    return null
  }
}
