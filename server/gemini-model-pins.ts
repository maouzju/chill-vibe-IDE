import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { getAppDataDir } from './app-paths.js'
import { resolveGeminiSystemSettingsPath } from './codex-safety.js'

// 症状：Gemini 卡走中转站时报「Model "gemini-2.5-pro" is not supported by any configured account in
//   this group」，之后每轮读完几个文件就静默结束（同一报错被连续去重藏掉）。2026-11-27 实证。
// 根因：gemini-cli 0.24.5 的内部调用不跟随 --model：上下文压缩（未知型号落到 chat-compression-default
//   = gemini-2.5-pro）、循环检测、编辑纠错、摘要、代码调查子 agent 都写死 2.5-pro/flash/flash-lite。
//   中转站分组只开了卡上选的型号，上下文一过 50% 压缩阈值整轮就失败。
// 为什么用 modelConfigs.customOverrides：CLI 解析内部别名后按「解析出的型号」匹配 override，
//   一条 match 就能把同名型号的所有内部用途改道，且保留各别名自己的 generateContentConfig；
//   逐个覆盖别名会丢掉 web-search 的 googleSearch 等工具配置。只在自定义地址（中转站）时启用，
//   官方端点这些内部小模型本来可用且更便宜。
const CLI_BUILT_IN_INTERNAL_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const mergeGeminiInternalModelPins = (settings: Record<string, unknown>, model: string) => {
  const modelConfigs = isRecord(settings.modelConfigs) ? settings.modelConfigs : {}
  const existingOverrides = Array.isArray(modelConfigs.customOverrides) ? modelConfigs.customOverrides : []
  const experimental = isRecord(settings.experimental) ? settings.experimental : {}
  const investigator = isRecord(experimental.codebaseInvestigatorSettings)
    ? experimental.codebaseInvestigatorSettings
    : {}
  const pins = CLI_BUILT_IN_INTERNAL_MODELS.filter((builtIn) => builtIn !== model).map((builtIn) => ({
    match: { model: builtIn },
    modelConfig: { model },
  }))
  return {
    ...settings,
    modelConfigs: { ...modelConfigs, customOverrides: [...existingOverrides, ...pins] },
    // 代码调查子 agent 不走别名：model=auto 时直接取 DEFAULT_GEMINI_MODEL，单独钉住。
    experimental: { ...experimental, codebaseInvestigatorSettings: { ...investigator, model } },
  }
}

// 叠在当前生效的 system 设置之上（安全钩子层或用户原有 system 设置），派生文件按内容哈希命名：
// 同一份底层设置 + 同一型号复用同一个文件，数量只随型号数增长。
export const pinGeminiInternalModels = async (env: NodeJS.ProcessEnv, model: string | undefined) => {
  const pinnedModel = model?.trim()
  if (!pinnedModel) {
    return
  }
  const currentSettingsPath = resolveGeminiSystemSettingsPath(env)
  const defaultsPath =
    env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH?.trim() ||
    path.join(path.dirname(currentSettingsPath), 'system-defaults.json')

  let current: Record<string, unknown> = {}
  const raw = await readFile(currentSettingsPath, 'utf8').catch(() => null)
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed)) current = parsed
    } catch {
      // 底层设置坏了 CLI 自己也读不了；只放型号钉子。
    }
  }

  const content = `${JSON.stringify(mergeGeminiInternalModelPins(current, pinnedModel), null, 2)}\n`
  const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
  const dir = path.join(getAppDataDir(), 'gemini-model-pins')
  await mkdir(dir, { recursive: true })
  const settingsPath = path.join(dir, `system-settings-${digest}.json`)
  const existing = await readFile(settingsPath, 'utf8').catch(() => null)
  if (existing !== content) {
    await writeFile(settingsPath, content, 'utf8')
  }

  env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath
  env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = defaultsPath
}
