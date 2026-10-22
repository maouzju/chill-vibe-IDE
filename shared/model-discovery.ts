import { MODEL_OPTIONS, TOOL_CARD_MODELS } from './models.js'
import type { ModelPickerCustomModel, Provider } from './schema.js'

// ---------------------------------------------------------------------------
// 新模型自动发现（SPEC model-auto-discovery）
//
// 症状（2026-09-02 ~ 10-14）：每出一个新型号，用户都要来一句「X 出了 跟进下」，等改代码发版才选得到。
// 做法：启动后问一次端点的模型列表，只把「比内置目录同家族最新的还新」的型号递给用户点头加入下拉。
// 被否决：把发现的型号直接并进 MODEL_OPTIONS —— 子 agent 提示词、超管目录、换代表都读它，
//   未验证的型号混进去会让 agent 自己选到不能用的模型。
// ---------------------------------------------------------------------------

export type DiscoveredModel = {
  provider: Provider
  model: string
  label: string
  key: string
}

export type ProviderModelDiscovery = {
  provider: Provider
  ids: string[]
  error?: string
}

export const buildDiscoveredModelKey = (provider: Provider, model: string) => `${provider}:${model}`

export const parseModelListIds = (body: unknown): string[] => {
  if (!body || typeof body !== 'object') return []
  const record = body as { data?: unknown; models?: unknown }
  const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : []
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const raw = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name
    if (typeof raw !== 'string') continue
    const id = raw.trim().replace(/^models\//, '')
    if (id) ids.push(id)
  }
  return ids
}

// 中转站会把同一模型的压缩/审查变体、嵌入、语音等一并列出（2026-10-22 duckcoding 实测 15 条里 8 条是
// `-openai-compact` 与 `codex-auto-review`），这些不是能在会话卡里聊天的模型。
const noisePattern =
  /(compact|auto-review|embed|tts|whisper|image|imagen|audio|realtime|moderation|search|transcribe|veo|aqa|-\d{8}$|-latest$)/i

const familyPrefix: Record<Provider, RegExp> = {
  claude: /^claude-/i,
  codex: /^gpt-/i,
  gemini: /^gemini-/i,
}

type ParsedVersion = { family: string; version: number[] }

const parseVersionNumbers = (text: string) => text.split(/[.-]/).map((part) => Number(part))

export const parseModelVersion = (provider: Provider, id: string): ParsedVersion | null => {
  const lower = id.toLowerCase()
  if (provider === 'claude') {
    // claude-<tier>-<maj>(-<min>)?(-YYYYMMDD)?
    const match = lower.match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/)
    if (!match) return null
    return { family: `claude:${match[1]}`, version: [Number(match[2]), Number(match[3] ?? 0)] }
  }
  if (provider === 'codex') {
    // gpt-<maj>(.<min>)?(-<tier>)?
    const match = lower.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?$/)
    if (!match) return null
    const [major, minor = 0] = parseVersionNumbers(match[1]!)
    return { family: `codex:${match[2] ?? 'base'}`, version: [major!, minor] }
  }
  // gemini-<maj>(.<min>)?-<tier…>(-preview)?
  const match = lower.match(/^gemini-(\d+(?:\.\d+)?)-([a-z-]+?)(?:-preview)?$/)
  if (!match) return null
  const [major, minor = 0] = parseVersionNumbers(match[1]!)
  return { family: `gemini:${match[2]}`, version: [major!, minor] }
}

const compareVersions = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const catalogVersionsByProvider = (provider: Provider) => {
  const families = new Map<string, number[]>()
  let newestMajor = 0
  for (const option of MODEL_OPTIONS) {
    if (option.provider !== provider || !option.model || TOOL_CARD_MODELS.has(option.model)) continue
    const parsed = parseModelVersion(provider, option.model)
    if (!parsed) continue
    const known = families.get(parsed.family)
    if (!known || compareVersions(parsed.version, known) > 0) families.set(parsed.family, parsed.version)
    newestMajor = Math.max(newestMajor, parsed.version[0] ?? 0)
  }
  return { families, newestMajor }
}

const capitalize = (word: string) => (word ? word[0]!.toUpperCase() + word.slice(1) : word)

export const buildDiscoveredModelLabel = (provider: Provider, id: string) => {
  const lower = id.toLowerCase()
  if (provider === 'claude') {
    const match = lower.match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?/)
    if (match) return `${capitalize(match[1]!)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
  }
  if (provider === 'codex') {
    const match = lower.match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/)
    if (match) {
      return `GPT-${match[1]}${match[2] ? ` ${match[2].split('-').map(capitalize).join(' ')}` : ''}`
    }
  }
  if (provider === 'gemini') {
    const match = lower.match(/^gemini-(\d+(?:\.\d+)?)-(.+)$/)
    if (match) return `Gemini ${match[1]} ${match[2]!.split('-').map(capitalize).join(' ')}`
  }
  return id
}

export const findDiscoveredNewModels = ({
  provider,
  ids,
  customModels = [],
  seen = [],
}: {
  provider: Provider
  ids: readonly string[]
  customModels?: readonly ModelPickerCustomModel[]
  seen?: readonly string[]
}): DiscoveredModel[] => {
  const known = new Set<string>([
    ...MODEL_OPTIONS.filter((option) => option.provider === provider).map((option) => option.model.toLowerCase()),
    ...customModels.filter((entry) => entry.provider === provider).map((entry) => entry.model.toLowerCase()),
  ])
  const seenKeys = new Set(seen)
  const { families, newestMajor } = catalogVersionsByProvider(provider)
  const result: DiscoveredModel[] = []
  const emitted = new Set<string>()

  for (const id of ids) {
    const lower = id.toLowerCase()
    const key = buildDiscoveredModelKey(provider, id)
    if (
      emitted.has(lower) ||
      known.has(lower) ||
      seenKeys.has(key) ||
      !familyPrefix[provider].test(id) ||
      noisePattern.test(id)
    ) {
      continue
    }
    const parsed = parseModelVersion(provider, id)
    if (!parsed) continue
    const catalogNewest = families.get(parsed.family)
    const isNewer = catalogNewest
      ? compareVersions(parsed.version, catalogNewest) > 0
      : (parsed.version[0] ?? 0) >= newestMajor
    if (!isNewer) continue

    emitted.add(lower)
    result.push({ provider, model: id, label: buildDiscoveredModelLabel(provider, id), key })
  }

  return result
}
