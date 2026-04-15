import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  readScenes,
  writeScenes,
  addScene,
  removeScene,
  createId,
  type NoiseGeneratorType,
  type NoiseLayer,
  type NoiseScene,
} from '../server/whitenoise/whitenoise-store.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

const VALID_GENERATORS: NoiseGeneratorType[] = [
  'rain', 'wind', 'stream', 'fire', 'night', 'white',
  'thunder', 'cafe', 'ocean', 'birds', 'pink', 'brown',
]

function makeLayer(generator: NoiseGeneratorType = 'rain', volume = 0.6): NoiseLayer {
  return { id: createId(), label: '测试', generator, volume }
}

function makeScene(overrides?: Partial<NoiseScene>): NoiseScene {
  return {
    id: createId(),
    title: '测试场景',
    prompt: '测试',
    layers: [makeLayer('rain'), makeLayer('wind', 0.4)],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ── Store tests ─────────────────────────────────────────────────────────────

describe('whitenoise-store', () => {
  // Use a temp directory for test isolation
  let originalEnv: string | undefined
  const testDir = path.join(import.meta.dirname ?? '.', '.whitenoise-test-' + Date.now())

  beforeEach(() => {
    originalEnv = process.env['CHILL_VIBE_DATA_DIR']
    process.env['CHILL_VIBE_DATA_DIR'] = testDir
    // Clean up before each test to ensure isolation
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* */ }
  })

  afterEach(() => {
    // Clean up test files
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch { /* */ }
    // Restore env
    if (originalEnv !== undefined) {
      process.env['CHILL_VIBE_DATA_DIR'] = originalEnv
    } else {
      delete process.env['CHILL_VIBE_DATA_DIR']
    }
  })

  it('returns empty array when no file exists', () => {
    const scenes = readScenes()
    assert.deepEqual(scenes, [])
  })

  it('writes and reads scenes round-trip', () => {
    const scene = makeScene()
    writeScenes([scene])
    const loaded = readScenes()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0].id, scene.id)
    assert.equal(loaded[0].title, scene.title)
    assert.equal(loaded[0].layers.length, 2)
    assert.equal(loaded[0].layers[0].generator, 'rain')
    assert.equal(loaded[0].layers[1].generator, 'wind')
  })

  it('addScene prepends to existing scenes', () => {
    const first = makeScene({ title: '第一个' })
    const second = makeScene({ title: '第二个' })
    writeScenes([first])
    const result = addScene(second)
    assert.equal(result.length, 2)
    assert.equal(result[0].title, '第二个', 'new scene should be first')
    assert.equal(result[1].title, '第一个')
  })

  it('removeScene deletes by id', () => {
    const a = makeScene({ title: 'A' })
    const b = makeScene({ title: 'B' })
    const c = makeScene({ title: 'C' })
    writeScenes([a, b, c])
    const result = removeScene(b.id)
    assert.equal(result.length, 2)
    assert.ok(result.every((s) => s.id !== b.id))
  })

  it('removeScene with nonexistent id is a no-op', () => {
    const scene = makeScene()
    writeScenes([scene])
    const result = removeScene('nonexistent')
    assert.equal(result.length, 1)
  })

  it('createId returns unique UUIDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createId()))
    assert.equal(ids.size, 100)
  })

  it('handles corrupted JSON gracefully', () => {
    const filePath = path.join(testDir, 'whitenoise-scenes.json')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(filePath, 'not valid json', 'utf8')
    const scenes = readScenes()
    assert.deepEqual(scenes, [])
  })

  it('filters out invalid entries', () => {
    const filePath = path.join(testDir, 'whitenoise-scenes.json')
    fs.mkdirSync(testDir, { recursive: true })
    const valid = makeScene()
    fs.writeFileSync(filePath, JSON.stringify([valid, null, 42, { noId: true }]), 'utf8')
    const scenes = readScenes()
    assert.equal(scenes.length, 1)
    assert.equal(scenes[0].id, valid.id)
  })
})

// ── Generator response parsing tests ────────────────────────────────────────

describe('whitenoise generator type coverage', () => {
  it('all generator types are valid strings', () => {
    for (const gen of VALID_GENERATORS) {
      assert.equal(typeof gen, 'string')
      assert.ok(gen.length > 0, `generator type should not be empty`)
    }
  })

  it('NoiseLayer accepts all generator types', () => {
    for (const gen of VALID_GENERATORS) {
      const layer = makeLayer(gen)
      assert.equal(layer.generator, gen)
    }
  })

  it('NoiseScene with multiple layers round-trips through JSON', () => {
    const scene = makeScene({
      layers: VALID_GENERATORS.map((g) => makeLayer(g, 0.5)),
    })
    const json = JSON.stringify(scene)
    const parsed = JSON.parse(json) as NoiseScene
    assert.equal(parsed.layers.length, VALID_GENERATORS.length)
    for (let i = 0; i < VALID_GENERATORS.length; i++) {
      assert.equal(parsed.layers[i].generator, VALID_GENERATORS[i])
    }
  })

  it('layer volumes are bounded 0-1', () => {
    const layer = makeLayer('rain', 0.6)
    assert.ok(layer.volume >= 0 && layer.volume <= 1)
  })
})
