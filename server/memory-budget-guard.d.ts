export type MemoryBudget = {
  minFreeGb: number
  minCommitGb: number
  maxHeavyProcesses: number
}

export type MemoryProcessSummary = {
  pid: number
  name: string
  workingSetBytes: number
  commandLine: string
}

export type MemorySnapshot = {
  freeBytes: number | null
  commitAvailableBytes: number | null
  heavyProcessCount: number | null
  topProcesses: MemoryProcessSummary[]
}

export const memoryBudgetStderrMarker: string
export const defaultMemoryBudget: Readonly<MemoryBudget>
export const heavyProcessMinWorkingSetBytes: number
export const memoryProbeTimeoutMs: number

export function isHeavyShellCommand(segments: string[]): boolean
export function readMemoryBudgetFromEnv(env?: NodeJS.ProcessEnv | Record<string, string | undefined>): MemoryBudget | null
export function evaluateMemoryBudget(
  snapshot: MemorySnapshot,
  budget: MemoryBudget,
): { allowed: boolean; reason?: string }
export function probeSystemMemory(options?: {
  budget?: MemoryBudget
  platform?: NodeJS.Platform
  timeoutMs?: number
}): Promise<MemorySnapshot | null>
