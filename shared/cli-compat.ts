import { z } from 'zod'

import type { Provider } from './schema.js'

// 每次发版确认兼容了哪个 CLI 版本，就改这里——它是「这个 IDE 版本保证兼容的 CLI」唯一出处，
// 设置面板展示它、一键下载的也是它。验证手段：scripts/probe-codex-app-server.mjs、
// scripts/probe-codex-tool-schema.mjs，以及 claude -p --output-format stream-json 实跑一轮。
export const compatibleCliVersions: Record<Provider, { version: string; npmPackage: string }> = {
  claude: { version: '2.1.280', npmPackage: '@anthropic-ai/claude-code' },
  codex: { version: '0.156.1', npmPackage: '@openai/codex' },
}

export const cliCompatProviderSchema = z.enum(['claude', 'codex'])

export const cliCompatEntrySchema = z.object({
  provider: cliCompatProviderSchema,
  compatibleVersion: z.string(),
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
