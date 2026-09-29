import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { promptVaultEntrySchema, type AppState, type PromptVaultEntry } from '../shared/schema.js'
import { defaultSystemPrompt, normalizeModelPromptRules, normalizeSystemPrompt } from '../shared/system-prompt.js'

// 症状：2026-09-29 用户报「每次更新系统提示词都被冲掉」。本机实证是 08-25 掉电那次读档兜底
//   （pitfall #389），但用户确认此后到 v0.21.0 之间在另一台电脑上又被冲过至少一次，那台现场拿不到。
// 根因未定：代码里所有已知的读档/保存路径都保留 settings，冲掉它的路径不止一条也不可枚举。
// 为什么另存一份而不是自动写回：用户也可能是自己点了「恢复内置提示词」。存档独立于 state.json，
//   任何把设置写回默认的路径都碰不到它；只在当前提示词已是默认时提示用户一键找回，并落一条日志留证。
const promptVaultFileName = 'prompt-vault.json'

const getPromptVaultPath = (dataDir: string) => path.join(dataDir, promptVaultFileName)

let tempCounter = 0
const warnedSavedAt = new Set<string>()

const isCustomPrompt = (settings: Pick<AppState['settings'], 'systemPrompt' | 'modelPromptRules'>) =>
  normalizeSystemPrompt(settings.systemPrompt) !== defaultSystemPrompt ||
  normalizeModelPromptRules(settings.modelPromptRules).length > 0

const samePrompt = (
  settings: Pick<AppState['settings'], 'systemPrompt' | 'modelPromptRules'>,
  entry: PromptVaultEntry,
) =>
  normalizeSystemPrompt(settings.systemPrompt) === normalizeSystemPrompt(entry.systemPrompt) &&
  JSON.stringify(normalizeModelPromptRules(settings.modelPromptRules)) ===
    JSON.stringify(normalizeModelPromptRules(entry.modelPromptRules))

export const readPromptVault = async (dataDir: string): Promise<PromptVaultEntry | null> => {
  try {
    const parsed = promptVaultEntrySchema.safeParse(
      JSON.parse(await readFile(getPromptVaultPath(dataDir), 'utf8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export const recordPromptVault = async (dataDir: string, settings: AppState['settings']) => {
  const existing = await readPromptVault(dataDir)

  if (!isCustomPrompt(settings)) {
    // 每份存档只留一条证据日志：流式期间每次排队保存都会走到这里。
    if (existing && !samePrompt(settings, existing) && !warnedSavedAt.has(existing.savedAt)) {
      warnedSavedAt.add(existing.savedAt)
      console.warn(
        `[prompt-vault] Saved settings carry the built-in system prompt; last custom prompt from ${existing.savedAt} kept in ${promptVaultFileName}.`,
      )
    }
    return
  }

  if (existing && samePrompt(settings, existing)) {
    return
  }

  const entry: PromptVaultEntry = {
    systemPrompt: normalizeSystemPrompt(settings.systemPrompt),
    modelPromptRules: normalizeModelPromptRules(settings.modelPromptRules),
    savedAt: new Date().toISOString(),
  }
  const target = getPromptVaultPath(dataDir)
  // 临时文件名唯一：loadState 的压缩保存不走写锁，可能与加锁保存并发写同一份存档。
  tempCounter += 1
  const temp = `${target}.${process.pid}.${tempCounter}.tmp`
  await mkdir(dataDir, { recursive: true })
  // 必须 fsync 再 rename：掉电（08-25）时 rename 落盘而数据没刷会得到 0 字节/全 NUL 存档，好存档也被替换掉。
  const handle = await open(temp, 'w')
  try {
    await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temp, target).catch(async (error) => {
    await unlink(temp).catch(() => undefined)
    throw error
  })
}

// 只在当前提示词已回落到内置默认、存档和当前不同、且用户没对这份存档点过「忽略」时下发。
export const getPromptVaultOffer = async (
  dataDir: string,
  settings: AppState['settings'],
): Promise<PromptVaultEntry | null> => {
  if (normalizeSystemPrompt(settings.systemPrompt) !== defaultSystemPrompt) {
    return null
  }

  const entry = await readPromptVault(dataDir)
  if (!entry || samePrompt(settings, entry) || settings.promptVaultDismissedAt === entry.savedAt) {
    return null
  }

  console.warn(`[prompt-vault] Current system prompt is the built-in default; offering custom prompt from ${entry.savedAt}.`)
  return entry
}
