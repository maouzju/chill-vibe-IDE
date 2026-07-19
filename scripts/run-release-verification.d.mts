export interface VerificationFingerprintInput {
  repoRoot: string
  head: string
  trackedDiff: string
  untrackedEntries: Array<{
    path: string
    hash: string
    mode?: string
  }>
}

export interface ReleaseStage {
  id: string
  label?: string
  command: string
  args: string[]
}

export interface ReleaseStageEvidence {
  status: string
  command: string
  durationMs?: number
}

export interface ReleaseVerificationState {
  fingerprint: string
  invalidatedAt?: string
  invalidatedByFingerprint?: string
  stages: Record<string, ReleaseStageEvidence>
}

export type ReleaseStageAction = 'run' | 'reuse' | 'not-selected'

export function createStageInvocation(
  stage: ReleaseStage,
  platform?: NodeJS.Platform,
  commandProcessor?: string,
): { command: string; args: string[] }

export function createVerificationFingerprint(input: VerificationFingerprintInput): string

export function resetInvalidatedVerificationState<T extends ReleaseVerificationState>(
  state: T,
): Omit<T, 'invalidatedAt' | 'invalidatedByFingerprint'> & {
  stages: Record<string, ReleaseStageEvidence>
}

export function resolveReleaseStagePlan(input: {
  stages: ReleaseStage[]
  state: ReleaseVerificationState | null
  fingerprint: string
  fresh: boolean
  selectedStageIds: string[]
}): Array<ReleaseStage & { commandText: string; action: ReleaseStageAction }>
