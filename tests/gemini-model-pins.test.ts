import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { mergeGeminiInternalModelPins, pinGeminiInternalModels } from '../server/gemini-model-pins.ts'

// 症状：Gemini 卡走中转站，长会话里先报「Model "gemini-2.5-pro" is not supported by any configured
//   account in this group」，之后每轮读完文件就静默结束（同一报错被连续去重藏掉）。2026-11-27 用户报。
// 根因：gemini-cli 0.24.5 的上下文压缩、循环检测、编辑纠错、代码调查子 agent 等内部调用写死
//   gemini-2.5-pro / 2.5-flash / 2.5-flash-lite，不跟随 --model；中转站分组只开了卡上选的模型。
//   一次搜索塞进 68 万字符让上下文过 50% 阈值，压缩改调 gemini-2.5-pro 被拒，整轮失败。

type PinnedSettings = {
  general: { vimMode: boolean }
  hooks: { enabled: boolean }
  experimental: { enableAgents: boolean; codebaseInvestigatorSettings: { model: string } }
  modelConfigs: { customOverrides: Array<{ match: { model: string }; modelConfig: { model: string } }> }
}

const CLI_BUILT_IN_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
]

test('merge redirects every CLI built-in internal model to the card model and keeps existing settings', () => {
  const merged = mergeGeminiInternalModelPins(
    {
      general: { vimMode: true },
      hooks: { enabled: true },
      experimental: { enableAgents: true },
      modelConfigs: { customOverrides: [{ match: { model: 'x' }, modelConfig: { model: 'y' } }] },
    },
    'gemini-4-neon',
  ) as unknown as PinnedSettings

  assert.equal(merged.general.vimMode, true)
  assert.equal(merged.hooks.enabled, true)
  assert.equal(merged.experimental.enableAgents, true)
  assert.equal(merged.experimental.codebaseInvestigatorSettings.model, 'gemini-4-neon')

  const overrides = merged.modelConfigs.customOverrides
  assert.deepEqual(overrides[0], { match: { model: 'x' }, modelConfig: { model: 'y' } })
  for (const builtIn of CLI_BUILT_IN_MODELS) {
    const pin = overrides.find((entry) => entry.match.model === builtIn)
    assert.ok(pin, builtIn)
    assert.equal(pin.modelConfig.model, 'gemini-4-neon')
  }
})

test('merge does not add a self-referencing pin when the card already uses a built-in model', () => {
  const merged = mergeGeminiInternalModelPins({}, 'gemini-2.5-flash') as unknown as PinnedSettings
  const overrides = merged.modelConfigs.customOverrides
  assert.equal(overrides.some((entry) => entry.match.model === 'gemini-2.5-flash'), false)
  assert.ok(overrides.some((entry) => entry.match.model === 'gemini-2.5-pro'))
})

test('pin writes a derived system settings layer on top of the current one and points the CLI at it', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-gemini-pins-'))
  const previousDataDir = process.env.CHILL_VIBE_DATA_DIR
  process.env.CHILL_VIBE_DATA_DIR = dataDir
  try {
    const currentSettings = path.join(dataDir, 'gemini-safety', 'system-settings.json')
    await mkdir(path.dirname(currentSettings), { recursive: true })
    await writeFile(currentSettings, JSON.stringify({ hooks: { enabled: true, BeforeTool: [{ matcher: 'm' }] } }))
    const env: NodeJS.ProcessEnv = {
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: currentSettings,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: 'orig/system-defaults.json',
    }

    await pinGeminiInternalModels(env, 'gemini-4-neon')

    assert.ok(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH)
    assert.notEqual(path.resolve(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!), path.resolve(currentSettings))
    assert.equal(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, 'orig/system-defaults.json')
    const written = JSON.parse(await readFile(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, 'utf8'))
    assert.deepEqual(written.hooks.BeforeTool, [{ matcher: 'm' }])
    assert.ok(
      written.modelConfigs.customOverrides.some(
        (entry: { match: { model: string }; modelConfig: { model: string } }) =>
          entry.match.model === 'gemini-2.5-pro' && entry.modelConfig.model === 'gemini-4-neon',
      ),
    )
  } finally {
    if (previousDataDir === undefined) delete process.env.CHILL_VIBE_DATA_DIR
    else process.env.CHILL_VIBE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('pin is a no-op without a model', async () => {
  const env: NodeJS.ProcessEnv = {}
  await pinGeminiInternalModels(env, '  ')
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined)
})
