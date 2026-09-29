import { z } from 'zod'

import type { Provider } from './schema.js'

// 每次发版确认兼容了哪个 CLI 版本，就改这里——它是「这个 IDE 版本保证兼容的 CLI」唯一出处，
// 设置面板展示它、一键下载的也是它。验证手段：scripts/probe-codex-app-server.mjs、
// scripts/probe-codex-tool-schema.mjs，以及 claude -p --output-format stream-json 实跑一轮。
//
// version = 推荐版本（一键下载装它，也是兼容区间上限）；minVersion = 仍保证可用的最老版本。
// 区间 [minVersion, version] 内的 CLI 一律不提示更新，用户不必跟着每个 IDE 版本升级 CLI。
// 抬 version 时 minVersion 默认不动；只有当新代码真的依赖了新 CLI 才有的能力（参数/协议/工具）时才抬它。
// 2026-09-29 升级实测：claude 2.1.280→2.1.284 --help 只增不删，stream-json/软打断/--resume 全通；
// codex 0.156.1→0.158.0 app-server 协议 schema 只增不删（gatewayOAuth 等），工具表逐项一致，真实回合通过。
export const compatibleCliVersions: Record<Provider, { version: string; minVersion: string; npmPackage: string }> = {
  claude: { version: '2.1.284', minVersion: '2.1.280', npmPackage: '@anthropic-ai/claude-code' },
  codex: { version: '0.158.0', minVersion: '0.156.1', npmPackage: '@openai/codex' },
}

const parseCliVersion = (version: string) => (version.match(/\d+/g) ?? []).slice(0, 3).map(Number)

/** 按数字逐段比较（2.1.100 > 2.1.99）；预发布后缀忽略。 */
export const compareCliVersions = (left: string, right: string) => {
  const a = parseCliVersion(left)
  const b = parseCliVersion(right)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export const isCliVersionInRange = (version: string | null | undefined, min: string, max: string) =>
  Boolean(version) && compareCliVersions(version!, min) >= 0 && compareCliVersions(version!, max) <= 0

export const cliCompatProviderSchema = z.enum(['claude', 'codex'])

export const cliCompatEntrySchema = z.object({
  provider: cliCompatProviderSchema,
  compatibleVersion: z.string(),
  // 可选：缺省时区间退化成只认 compatibleVersion 一个版本（旧行为）。
  minCompatibleVersion: z.string().optional(),
  installed: z.boolean(),
  active: z.boolean(),
  activeVersion: z.string().nullable(),
  systemVersion: z.string().nullable(),
  task: z
    .object({
      status: z.enum(['running', 'succeeded', 'failed']),
      message: z.string(),
    })
    .nullable(),
})

export const cliCompatStatusSchema = z.object({
  entries: z.array(cliCompatEntrySchema),
})

export const cliCompatRequestSchema = z.object({
  provider: cliCompatProviderSchema,
  active: z.boolean().optional(),
})

export type CliCompatEntry = z.infer<typeof cliCompatEntrySchema>
export type CliCompatStatus = z.infer<typeof cliCompatStatusSchema>
export type CliCompatRequest = z.infer<typeof cliCompatRequestSchema>

/**
 * 要不要提示「下载/切换兼容版」：实际在用的那个 CLI（兼容私有副本优先，否则系统 CLI）落在兼容区间内就不用。
 * 09-23 用户截图：系统 CLI 已是 v2.1.280 仍提示「下载兼容版并切换」。
 * 09-29 改成区间：IDE 抬了推荐版本后，区间内的系统 CLI / 旧兼容副本照常可用，不再逼用户跟着升级。
 * 设置面板和健康灯共用这一条判据。
 */
export const cliCompatNeedsAction = (entry: CliCompatEntry) => {
  const inUseVersion = entry.activeVersion ?? entry.systemVersion
  return !isCliVersionInRange(inUseVersion, entry.minCompatibleVersion ?? entry.compatibleVersion, entry.compatibleVersion)
}
