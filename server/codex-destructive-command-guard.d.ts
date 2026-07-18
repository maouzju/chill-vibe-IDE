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
}

export function assessCodexToolUse(
  input: CodexPreToolUseInput,
  options?: CodexSafetyAssessmentOptions,
): CodexSafetyAssessment
