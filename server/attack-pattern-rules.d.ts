export type AttackPatternFamily =
  | 'remote-pipe-exec'
  | 'encoded-exec'
  | 'persistence'
  | 'package-source-switch'
  | 'mining-or-c2'

export type AttackPatternRule = {
  id: string
  family: AttackPatternFamily
  label: string
  pattern: RegExp
}

export type AttackPatternMatch = {
  id: string
  family: AttackPatternFamily
  label: string
  sample: string
}

export const attackPatternFamilies: readonly AttackPatternFamily[]
export const attackPatternRules: readonly AttackPatternRule[]
export function detectAttackPatterns(input: unknown): AttackPatternMatch[]
export function formatAttackPatternReason(matches: AttackPatternMatch[]): string
