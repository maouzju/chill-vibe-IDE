import type { AppTheme } from './schema.js'

export type ResolvedAppTheme = 'light' | 'dark'

export const resolveAppTheme = (theme: AppTheme, prefersDark: boolean): ResolvedAppTheme =>
  theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
