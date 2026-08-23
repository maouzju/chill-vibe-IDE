export interface AuditGitHistoryOptions {
  repoRoot?: string
  timeoutMs?: number
}

export interface AuditGitHistoryFinding {
  category: string
  path: string
  line?: number
  oid: string
  commits: string[]
  refs: string[]
  refCount: number
}

export interface AuditGitHistoryReport {
  objectCount: number
  findingCount: number
  findings: AuditGitHistoryFinding[]
}

export function auditGitHistory(options?: AuditGitHistoryOptions): Promise<AuditGitHistoryReport>
