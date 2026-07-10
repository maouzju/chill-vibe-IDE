import type { AppTheme } from './schema.js'

export type ResolvedAppTheme = 'light' | 'dark'

type RgbColor = {
  red: number
  green: number
  blue: number
}

export type ThemeAccentTokens = Record<`--${string}`, string>

const defaultThemeAccentColors: Record<ResolvedAppTheme, string> = {
  light: '#0969da',
  dark: '#2f81f7',
}

const themeSurfaces: Record<ResolvedAppTheme, string> = {
  light: '#ffffff',
  dark: '#0d1117',
}

const darkForeground = '#0d1117'
const lightForeground = '#ffffff'

const hexColorPattern = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

export const normalizeAccentColor = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!hexColorPattern.test(normalized)) {
    return null
  }

  if (normalized.length === 4) {
    return `#${normalized.slice(1).split('').map((channel) => channel.repeat(2)).join('')}`
  }

  return normalized
}

const hexToRgb = (value: string): RgbColor => ({
  red: Number.parseInt(value.slice(1, 3), 16),
  green: Number.parseInt(value.slice(3, 5), 16),
  blue: Number.parseInt(value.slice(5, 7), 16),
})

const channelToHex = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')

const rgbToHex = ({ red, green, blue }: RgbColor) =>
  `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`

const mixRgb = (from: RgbColor, to: RgbColor, amount: number): RgbColor => ({
  red: from.red + (to.red - from.red) * amount,
  green: from.green + (to.green - from.green) * amount,
  blue: from.blue + (to.blue - from.blue) * amount,
})

const linearizeChannel = (value: number) => {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

const relativeLuminance = ({ red, green, blue }: RgbColor) =>
  linearizeChannel(red) * 0.2126 +
  linearizeChannel(green) * 0.7152 +
  linearizeChannel(blue) * 0.0722

const contrastRatio = (left: RgbColor, right: RgbColor) => {
  const leftLuminance = relativeLuminance(left)
  const rightLuminance = relativeLuminance(right)
  return (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
}

const ensureSurfaceContrast = (color: RgbColor, theme: ResolvedAppTheme) => {
  const surface = hexToRgb(themeSurfaces[theme])
  const target = hexToRgb(theme === 'light' ? darkForeground : lightForeground)
  let adjusted = color

  for (let index = 0; index < 24 && contrastRatio(adjusted, surface) < 3; index += 1) {
    adjusted = mixRgb(adjusted, target, 0.08)
  }

  return adjusted
}

const chooseAccentForeground = (accent: RgbColor) => {
  const dark = hexToRgb(darkForeground)
  const light = hexToRgb(lightForeground)
  return contrastRatio(accent, light) >= contrastRatio(accent, dark)
    ? lightForeground
    : darkForeground
}

const toRgbChannels = ({ red, green, blue }: RgbColor) =>
  `${Math.round(red)} ${Math.round(green)} ${Math.round(blue)}`

const toAlphaColor = (color: RgbColor, alpha: number) =>
  `rgb(${toRgbChannels(color)} / ${alpha})`

export const getDefaultThemeAccentColor = (theme: ResolvedAppTheme) =>
  defaultThemeAccentColors[theme]

export type ThemeSurfaceTokens = Record<`--${string}`, string>

const defaultThemeSurfaceColors: Record<ResolvedAppTheme, string> = {
  light: '#e2ddd5',
  dark: '#141a24',
}

export const getDefaultThemeSurfaceColor = (theme: ResolvedAppTheme) =>
  defaultThemeSurfaceColors[theme]

/** Pick the ink template that keeps text readable on the chosen base color. */
export const getSurfaceBaseAppearance = (value: unknown): ResolvedAppTheme | null => {
  const normalized = normalizeAccentColor(value)
  if (!normalized) {
    return null
  }

  const base = hexToRgb(normalized)
  const light = hexToRgb(lightForeground)
  const dark = hexToRgb(darkForeground)
  return contrastRatio(base, light) >= contrastRatio(base, dark) ? 'dark' : 'light'
}

const white: RgbColor = { red: 255, green: 255, blue: 255 }

export const createThemeSurfaceTokens = (value: unknown): ThemeSurfaceTokens | null => {
  const normalized = normalizeAccentColor(value)
  if (!normalized) {
    return null
  }

  const base = hexToRgb(normalized)
  const isDark = getSurfaceBaseAppearance(normalized) === 'dark'

  // Panels always rise toward white above the page, mirroring the ratio the
  // built-in palettes use: a whisper on dark bases, near-white on light ones.
  const lift = (amount: number, alpha: number) => toAlphaColor(mixRgb(base, white, amount), alpha)

  return isDark
    ? {
        '--page-bg': normalized,
        '--page': rgbToHex(mixRgb(base, white, 0.02)),
        '--panel': lift(0.05, 0.8),
        '--panel-strong': lift(0.1, 0.96),
        '--panel-soft': lift(0.02, 0.78),
        '--input-strong-bg': lift(0.09, 0.92),
        '--input-strong-bg-focus': lift(0.13, 0.98),
        '--menu-bg': lift(0.06, 0.96),
        '--empty-state-bg': lift(0.02, 0.92),
      }
    : {
        '--page-bg': normalized,
        '--page': rgbToHex(mixRgb(base, white, 0.08)),
        '--panel': lift(0.62, 0.78),
        '--panel-strong': lift(0.85, 0.97),
        '--panel-soft': lift(0.4, 0.7),
        '--input-strong-bg': lift(0.5, 0.75),
        '--input-strong-bg-focus': lift(0.85, 0.95),
        '--menu-bg': lift(0.8, 0.94),
        '--empty-state-bg': lift(0.75, 0.85),
      }
}

export const createThemeAccentTokens = (
  value: unknown,
  theme: ResolvedAppTheme,
): ThemeAccentTokens | null => {
  const normalized = normalizeAccentColor(value)
  if (!normalized) {
    return null
  }

  const accentRgb = ensureSurfaceContrast(hexToRgb(normalized), theme)
  const accent = rgbToHex(accentRgb)
  const accent2Rgb = mixRgb(
    accentRgb,
    hexToRgb(theme === 'light' ? darkForeground : lightForeground),
    0.18,
  )
  const accent3Rgb = mixRgb(accentRgb, hexToRgb(lightForeground), theme === 'light' ? 0.18 : 0.3)
  const contrast = chooseAccentForeground(accentRgb)
  const contrastRgb = hexToRgb(contrast)
  const isDark = theme === 'dark'

  return {
    '--accent': accent,
    '--accent-2': rgbToHex(accent2Rgb),
    '--accent-3': rgbToHex(accent3Rgb),
    '--accent-soft': toAlphaColor(accentRgb, isDark ? 0.12 : 0.08),
    '--accent-glow': toAlphaColor(accentRgb, isDark ? 0.2 : 0.18),
    '--accent-line': toAlphaColor(accentRgb, isDark ? 0.18 : 0.14),
    '--accent-line-strong': toAlphaColor(accentRgb, isDark ? 0.3 : 0.28),
    '--accent-contrast': contrast,
    '--accent-contrast-muted': toAlphaColor(contrastRgb, 0.82),
    '--card-header-bg': `color-mix(in srgb, ${accent} ${isDark ? 11 : 9}%, var(--panel))`,
    '--card-header-bg-hover': `color-mix(in srgb, ${accent} ${isDark ? 15 : 13}%, var(--panel))`,
    '--card-header-border': toAlphaColor(accentRgb, isDark ? 0.16 : 0.12),
    '--drop-target-border': toAlphaColor(accentRgb, isDark ? 0.3 : 0.28),
    '--drop-target-bg': toAlphaColor(accentRgb, isDark ? 0.1 : 0.06),
    '--drop-target-shadow': `inset 0 0 0 1px ${toAlphaColor(accentRgb, isDark ? 0.14 : 0.12)}`,
    '--menu-hover-bg': toAlphaColor(accentRgb, isDark ? 0.1 : 0.06),
    '--shadow-btn-primary': isDark
      ? `0 6px 18px ${toAlphaColor(accent2Rgb, 0.3)}, 0 2px 6px ${toAlphaColor(accent2Rgb, 0.24)}, inset 0 1px 0 rgb(255 255 255 / 0.08)`
      : `0 2px 6px ${toAlphaColor(accent2Rgb, 0.32)}, 0 1px 2px ${toAlphaColor(accent2Rgb, 0.22)}`,
    '--shadow-btn-primary-hover': isDark
      ? `0 8px 24px ${toAlphaColor(accent2Rgb, 0.34)}, 0 3px 8px ${toAlphaColor(accent2Rgb, 0.28)}`
      : `0 4px 12px ${toAlphaColor(accent2Rgb, 0.36)}, 0 2px 4px ${toAlphaColor(accent2Rgb, 0.26)}`,
    '--git-tool-border': toAlphaColor(accentRgb, isDark ? 0.16 : 0.14),
    '--git-tool-pill-bg': toAlphaColor(accentRgb, isDark ? 0.12 : 0.08),
    '--git-tool-pill-border': toAlphaColor(accentRgb, isDark ? 0.2 : 0.16),
    '--git-tool-notice-info-bg': toAlphaColor(accentRgb, isDark ? 0.12 : 0.08),
    '--git-tool-notice-info-border': toAlphaColor(accentRgb, isDark ? 0.16 : 0.14),
    '--git-tool-notice-success-bg': toAlphaColor(accentRgb, isDark ? 0.16 : 0.1),
    '--git-tool-notice-success-border': toAlphaColor(accentRgb, isDark ? 0.22 : 0.18),
  }
}

export const resolveAppTheme = (
  theme: AppTheme,
  prefersDark: boolean,
  customThemeBase: ResolvedAppTheme = 'dark',
): ResolvedAppTheme => {
  if (theme === 'custom') {
    return customThemeBase
  }

  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme
}
