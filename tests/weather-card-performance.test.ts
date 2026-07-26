import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const weatherCardSource = () =>
  readFileSync(new URL('../src/components/WeatherCard.tsx', import.meta.url), 'utf8')

const stylesSource = () => readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

const weatherOverlaySource = () =>
  readFileSync(new URL('../src/components/WeatherAmbientOverlay.tsx', import.meta.url), 'utf8')

// Strict on purpose: an "optional" variant silently tolerated a keyframe name
// that had not existed since 0.15.9 (`weather-snow-sway`, folded into
// `weather-snow-fall`'s `var(--sway)` translate), so the loop below quietly
// covered 2 of its 3 named animations. A typo or rename must fail loudly here
// instead of shrinking coverage for the infinite weather motion that AGENTS.md
// pitfalls 216/218 make expensive.
function extractKeyframes(css: string, name: string): string {
  const start = css.indexOf(`@keyframes ${name}`)
  assert.notEqual(
    start,
    -1,
    `missing @keyframes ${name} in src/index.css — fix the name here or drop the reference; do not let this assertion go quiet`,
  )

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
  // The transform/opacity-only weather keyframes from the infinite allowlist in
  // tests/idle-animation-budget.test.ts, so none of them can quietly move back
  // onto a layout- or paint-bound property. `weather-lightning-flash` and
  // `weather-bolt` are deliberately excluded: they animate `background` and
  // `height` and would need a separate (stricter) fix, not a green assertion.
  const names = [
    'weather-rain-fall',
    'weather-snow-fall',
    'weather-streak-fall',
    'weather-rain-splash',
    'weather-cloud-drift',
    'weather-sun-rotate',
    'weather-stars-twinkle',
    'weather-fog-drift-1',
    'weather-fog-drift-2',
    'weather-fog-drift-3',
  ]
  const blocks = names.map((name) => ({ name, block: extractKeyframes(css, name) }))

  assert.equal(blocks.length, names.length, 'expected every weather motion keyframe to be covered')

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
