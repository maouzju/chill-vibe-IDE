export interface ReleaseSafetyFinding {
  category: string
  path: string
  line?: number
}

export interface ReleaseSafetyAuditOptions {
  baselineText?: string
  /** Test seam: whether an absolute Windows path exists on this machine. Defaults to a cached fs check on win32. */
  localPathExists?: (absolutePath: string) => boolean
}

export interface ReleaseCandidateAuditOptions {
  repoRoot?: string
  base?: string
  notesFiles?: string[]
}

export function createReleaseSafetyFinding(
  pathName: string,
  category: string,
  line?: number,
): ReleaseSafetyFinding

export function auditReleaseText(
  pathName: string,
  text: string,
  options?: ReleaseSafetyAuditOptions,
): ReleaseSafetyFinding[]

export function auditReleasePath(
  pathName: string,
  text: string,
  options?: ReleaseSafetyAuditOptions,
): ReleaseSafetyFinding[]

export function auditReleaseCandidate(
  options?: ReleaseCandidateAuditOptions,
): Promise<ReleaseSafetyFinding[]>

export function redactReleaseLogText(
  text: string,
  options?: {
    repoRoot?: string
    sensitiveValues?: string[]
    env?: Record<string, string | undefined>
  },
): string

export function createReleaseLogRedactor(options?: {
  repoRoot?: string
  sensitiveValues?: string[]
  env?: Record<string, string | undefined>
}): {
  push(chunk: string | Uint8Array): string
  flush(): string
}
