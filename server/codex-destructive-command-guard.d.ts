export type CodexPreToolUseInput = {
  cwd?: string
  tool_name?: string
  tool_input?: {
    command?: string | string[]
    [key: string]: unknown
  }
}

export type CodexSafetyAssessment = {
  allowed: boolean
  reason?: string
}

export type CodexSafetyAssessmentOptions = {
  platform?: NodeJS.Platform
  workspaceRoot?: string
  protectedHome?: string
  codexHome?: string
  appDataDir?: string
  mountPoints?: string[]
  destructiveCommandProtectionEnabled?: boolean
  outsideWorkspaceWriteEnabled?: boolean
}

export function assessCodexToolUse(
  input: CodexPreToolUseInput,
  options?: CodexSafetyAssessmentOptions,
): CodexSafetyAssessment

export const attackPatternExitCode: number
export const destructiveCommandExitCode: number
export const attackPatternStderrMarker: string
export const memoryBudgetExitCode: number

export function isHeavyShellToolCommand(command: unknown): boolean

export type GuardVerdict = {
  exitCode: number
  reason: string
  raw?: boolean
}

export function evaluateToolUse(
  input: CodexPreToolUseInput,
  options?: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    probeMemory?: (options: { budget: import('./memory-budget-guard.js').MemoryBudget }) => Promise<import('./memory-budget-guard.js').MemorySnapshot | null>
  },
): Promise<GuardVerdict | null>
