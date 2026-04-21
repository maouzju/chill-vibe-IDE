import type { AppTheme } from '../shared/schema'
import { resolveAppTheme, type ResolvedAppTheme } from '../shared/theme'

const systemDarkModeQuery = '(prefers-color-scheme: dark)'

const supportsSystemThemeQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'

export const getSystemPrefersDark = () =>
  supportsSystemThemeQuery() ? window.matchMedia(systemDarkModeQuery).matches : true

export const getResolvedAppTheme = (theme: AppTheme): ResolvedAppTheme =>
  resolveAppTheme(theme, getSystemPrefersDark())

export const subscribeToSystemThemeChange = (onChange: () => void) => {
  if (!supportsSystemThemeQuery()) {
    return () => undefined
  }

  const mediaQuery = window.matchMedia(systemDarkModeQuery)
  const listener = () => onChange()

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', listener)
    return () => mediaQuery.removeEventListener('change', listener)
  }

  mediaQuery.addListener(listener)
  return () => mediaQuery.removeListener(listener)
}
