import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const weatherCardSource = () =>
  readFileSync(new URL('../src/components/WeatherCard.tsx', import.meta.url), 'utf8')

const stylesSource = () => readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

const weatherOverlaySource = () =>
  readFileSync(new URL('../src/components/WeatherAmbientOverlay.tsx', import.meta.url), 'utf8')

function extractOptionalKeyframes(css: string, name: string): string | null {
  const start = css.indexOf(`@keyframes ${name}`)
  if (start === -1) return null

  const firstBrace = css.indexOf('{', start)
  assert.notEqual(firstBrace, -1, `missing opening brace for ${name}`)

  let depth = 0
  for (let index = firstBrace; index < css.length; index += 1) {
    const char = css[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return css.slice(firstBrace + 1, index)
      }
    }
  }

  assert.fail(`missing closing brace for ${name}`)
}

test('weather card avoids SVG turbulence filters in the hot render path', () => {
  assert.doesNotMatch(
    weatherCardSource(),
    /feTurbulence|feDisplacementMap|CloudSvgFilter|url\(#cloud-filter/,
  )
})

test('weather card continuous animations stay off layout and paint-bound properties', () => {
  const css = stylesSource()
  const blocks = [
    'weather-rain-fall',
    'weather-snow-fall',
    'weather-snow-sway',
  ].flatMap((name) => {
    const block = extractOptionalKeyframes(css, name)
    return block ? [{ name, block }] : []
  })

  assert.ok(blocks.length >= 2, 'expected weather motion keyframes to be covered')

  for (const { name, block } of blocks) {
    assert.doesNotMatch(
      block,
      /background-position|margin-left/,
      `${name} should animate transform/opacity instead of repainting or relayouting`,
    )
  }
})

test('weather ambient overlay avoids fixed geometry polling', () => {
  const source = weatherOverlaySource()

  assert.doesNotMatch(source, /setInterval\(track,\s*1000\)/)
  assert.doesNotMatch(source, /setRect\(el\?\.getBoundingClientRect\(\) \?\? null\)/)
  assert.match(source, /requestAnimationFrame/)
})
