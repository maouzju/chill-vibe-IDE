import {
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ClaudeCompletionBoundary = 'terminal' | 'background-pending' | 'unknown'

export type ClaudeCompletionBoundaryHook = {
  command: string
  args: string[]
}

type ClaudeStopHookInput = {
  background_tasks?: unknown
  session_crons?: unknown
}

const boundaryDirectory = path.join(
  os.tmpdir(),
  'chill-vibe-claude-completion',
  String(process.pid),
)

const quotePowerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
const quotePosixLiteral = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

export const getClaudeCompletionBoundaryPath = (cardId: string) => {
  mkdirSync(boundaryDirectory, { recursive: true })
  const safeCardId = cardId.replaceAll(/[^a-zA-Z0-9._-]/g, '_') || 'unknown-card'
  return path.join(boundaryDirectory, `${safeCardId}.json`)
}

export const buildClaudeCompletionBoundaryHookCommand = (
  snapshotPath: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeCompletionBoundaryHook => {
  const directory = path.dirname(snapshotPath)
  if (platform === 'win32') {
    const script = [
      '$inputJson=[Console]::In.ReadToEnd()',
      `[System.IO.Directory]::CreateDirectory(${quotePowerShellLiteral(directory)}) | Out-Null`,
      `[System.IO.File]::WriteAllText(${quotePowerShellLiteral(snapshotPath)},$inputJson,[System.Text.UTF8Encoding]::new($false))`,
    ].join('; ')
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
    }
  }

  return {
    command: '/bin/sh',
    args: [
      '-c',
      `umask 077; mkdir -p ${quotePosixLiteral(directory)}; cat > ${quotePosixLiteral(snapshotPath)}`,
    ],
  }
}

export const clearClaudeCompletionBoundarySnapshot = (snapshotPath: string) => {
  try {
    rmSync(snapshotPath, { force: true })
  } catch {
    // Missing or locked compatibility sidecars must not block a provider turn.
  }
}

export const readClaudeCompletionBoundary = (
  snapshotPath: string,
): ClaudeCompletionBoundary => {
  let parsed: ClaudeStopHookInput
  try {
    parsed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ClaudeStopHookInput
  } catch {
    return 'unknown'
  }

  if (!Array.isArray(parsed.background_tasks) || !Array.isArray(parsed.session_crons)) {
    return 'unknown'
  }

  return parsed.background_tasks.length > 0 || parsed.session_crons.length > 0
    ? 'background-pending'
    : 'terminal'
}
