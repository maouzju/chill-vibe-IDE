import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getResolvedAppTheme } from '../src/theme.ts'
import {
  createThemeAccentTokens,
  createThemeSurfaceTokens,
  getDefaultThemeAccentColor,
  getSurfaceBaseAppearance,
  normalizeAccentColor,
  resolveAppTheme,
} from '../shared/theme.ts'

const originalWindow = globalThis.window

const hexToRgb = (value: string) => {
  const hex = value.slice(1)
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
}

const relativeLuminance = (value: string) => {
  const channels = hexToRgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

const contrastRatio = (left: string, right: string) => {
  const leftLuminance = relativeLuminance(left)
  const rightLuminance = relativeLuminance(right)
  return (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
}

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
    return
  }

  ;(globalThis as typeof globalThis & { window?: Window }).window = originalWindow
})

describe('theme runtime helpers', () => {
  it('falls back to dark when system theme detection is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'window')

    assert.equal(getResolvedAppTheme('system'), 'dark')
  })

  it('resolves the custom theme from its configured base appearance', () => {
    assert.equal(resolveAppTheme('custom', true, 'light'), 'light')
    assert.equal(resolveAppTheme('custom', false, 'dark'), 'dark')
    assert.equal(resolveAppTheme('custom', false), 'dark')
    assert.equal(resolveAppTheme('system', true, 'light'), 'dark')

    Reflect.deleteProperty(globalThis, 'window')
    assert.equal(getResolvedAppTheme('custom', 'light'), 'light')
    assert.equal(getResolvedAppTheme('custom'), 'dark')
  })

  it('normalizes supported hex colors into persisted lowercase values', () => {
    assert.equal(normalizeAccentColor('#AbC'), '#aabbcc')
    assert.equal(normalizeAccentColor(' #12aBcF '), '#12abcf')
    assert.equal(normalizeAccentColor('rgb(1, 2, 3)'), null)
    assert.equal(normalizeAccentColor(null), null)
  })

  it('keeps the existing default accent when no custom color is configured', () => {
    assert.equal(getDefaultThemeAccentColor('light'), '#0969da')
    assert.equal(getDefaultThemeAccentColor('dark'), '#2f81f7')
    assert.equal(createThemeAccentTokens(null, 'light'), null)
  })

  it('derives theme tokens and readable foregrounds from a custom color', () => {
    const tokens = createThemeAccentTokens('#c2410c', 'light')

    assert.ok(tokens)
    assert.equal(tokens['--accent'], '#c2410c')
    assert.equal(tokens['--accent-contrast'], '#ffffff')
    assert.match(tokens['--accent-soft'], /^rgb\(194 65 12 \/ 0\.08\)$/)
    assert.match(tokens['--card-header-bg'], /^color-mix\(/)
    assert.match(tokens['--git-tool-pill-bg'], /^rgb\(194 65 12 \/ 0\.08\)$/)
  })

  it('classifies custom base colors into a light or dark appearance', () => {
    assert.equal(getSurfaceBaseAppearance('#0d1117'), 'dark')
    assert.equal(getSurfaceBaseAppearance('#1a2b1e'), 'dark')
    assert.equal(getSurfaceBaseAppearance('#ffffff'), 'light')
    assert.equal(getSurfaceBaseAppearance('#f0e8d8'), 'light')
    assert.equal(getSurfaceBaseAppearance('not-a-color'), null)
    assert.equal(getSurfaceBaseAppearance(null), null)
  })

  it('derives surface tokens from a custom base color', () => {
    const darkTokens = createThemeSurfaceTokens('#1a2b1e')

    assert.ok(darkTokens)
    assert.equal(darkTokens['--page-bg'], '#1a2b1e')
    for (const key of [
      '--page',
      '--panel',
      '--panel-strong',
      '--panel-soft',
      '--input-strong-bg',
      '--input-strong-bg-focus',
      '--menu-bg',
      '--empty-state-bg',
    ]) {
      assert.ok(darkTokens[key as keyof typeof darkTokens], `missing ${key}`)
    }

    // Dark base: panels rise toward white, so they stay distinguishable from the page.
    const panel = darkTokens['--panel']
    assert.match(panel, /^rgb\(/)

    const lightTokens = createThemeSurfaceTokens('#f0e8d8')
    assert.ok(lightTokens)
    assert.equal(lightTokens['--page-bg'], '#f0e8d8')

    assert.equal(createThemeSurfaceTokens('nope'), null)
    assert.equal(createThemeSurfaceTokens(null), null)
  })

  it('pulls extreme colors toward the current surface so accents stay visible', () => {
    const lightTokens = createThemeAccentTokens('#ffffff', 'light')
    const darkTokens = createThemeAccentTokens('#000000', 'dark')

    assert.ok(lightTokens)
    assert.ok(darkTokens)
    assert.notEqual(lightTokens['--accent'], '#ffffff')
    assert.notEqual(darkTokens['--accent'], '#000000')
    assert.ok(contrastRatio(lightTokens['--accent'], '#ffffff') >= 3)
    assert.ok(contrastRatio(darkTokens['--accent'], '#0d1117') >= 3)
    assert.ok(contrastRatio(lightTokens['--accent'], lightTokens['--accent-contrast']) >= 4.5)
    assert.ok(contrastRatio(darkTokens['--accent'], darkTokens['--accent-contrast']) >= 4.5)
  })
})
