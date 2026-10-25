import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getActiveProviderProfile } from '../shared/default-state.js'
import { parseModelListIds, type ProviderModelDiscovery } from '../shared/model-discovery.js'
import { isCliLoginProfile, type AppSettings, type Provider } from '../shared/schema.js'

// 新模型自动发现的服务端一半：问「CLI 实际在用」的那个端点要模型列表。
// 凭证来源必须和 CLI 真正生效的一致（见 server/providers.ts:588 的双来源说明）：
//   路由开且有 profile key → 应用内 profile；否则 Claude 读 ~/.claude/settings.json env（优先于进程
//   环境变量，记忆 chill-vibe-routing-loses-to-user-settings），Codex 读 ~/.codex/config.toml 当前
//   model_provider 段 + auth.json。找不到 key 就不发请求——绝不匿名打外网。

export type ModelDiscoveryIo = {
  homedir: string
  env: Record<string, string | undefined>
  readFile: (filePath: string) => Promise<string>
}

export type ModelDiscoveryEndpoint = {
  url: string
  headers: Record<string, string>
}

const defaultIo: ModelDiscoveryIo = {
  homedir: os.homedir(),
  env: process.env,
  readFile: (filePath) => readFile(filePath, 'utf8'),
}

const defaultBaseUrls: Record<Provider, string> = {
  codex: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
}

const discoveryTimeoutMs = 10_000

const trimSlashes = (value: string) => value.trim().replace(/\/+$/, '')

const readOptional = async (io: ModelDiscoveryIo, filePath: string) => {
  try {
    return await io.readFile(filePath)
  } catch {
    return null
  }
}

const parseJsonObject = (text: string | null): Record<string, unknown> => {
  if (!text) return {}
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const readTomlString = (line: string, key: string) => {
  const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
  return match ? (match[1] ?? match[2] ?? '') : null
}

// 只认本功能需要的三个键；按段落区分「顶层 model_provider」与「[model_providers.<name>] 里的 base_url/env_key」。
export const readCodexProviderConfig = (toml: string) => {
  let section = ''
  let modelProvider = ''
  const sections = new Map<string, { baseUrl?: string; envKey?: string }>()
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      section = header[1]!.trim()
      continue
    }
    if (!section) {
      modelProvider = readTomlString(line, 'model_provider') ?? modelProvider
      continue
    }
    const providerSection = section.match(/^model_providers\.(?:"([^"]+)"|([\w-]+))$/)
    if (!providerSection) continue
    const name = providerSection[1] ?? providerSection[2]!
    const entry = sections.get(name) ?? {}
    entry.baseUrl = readTomlString(line, 'base_url') ?? entry.baseUrl
    entry.envKey = readTomlString(line, 'env_key') ?? entry.envKey
    sections.set(name, entry)
  }
  return { modelProvider, provider: modelProvider ? sections.get(modelProvider) : undefined }
}

const buildEndpoint = (provider: Provider, baseUrl: string, apiKey: string): ModelDiscoveryEndpoint => {
  const base = trimSlashes(baseUrl || defaultBaseUrls[provider])
  if (provider === 'claude') {
    return {
      url: `${base}/v1/models`,
      headers: { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' },
    }
  }
  if (provider === 'gemini') {
    return { url: `${base}/v1beta/models`, headers: { 'x-goog-api-key': apiKey } }
  }
  return { url: `${base}/models`, headers: { authorization: `Bearer ${apiKey}` } }
}

export const resolveModelDiscoveryEndpoint = async (
  provider: Provider,
  settings: AppSettings,
  io: ModelDiscoveryIo = defaultIo,
): Promise<ModelDiscoveryEndpoint | null> => {
  if (settings.cliRoutingEnabled) {
    const profile = getActiveProviderProfile(settings, provider)
    // 官方会员登录没有可探测的 key，也不该回落去读全局配置里的中转站。
    if (isCliLoginProfile(profile)) return null
    const apiKey = profile?.apiKey.trim()
    if (apiKey) return buildEndpoint(provider, profile?.baseUrl ?? '', apiKey)
  }

  if (provider === 'claude') {
    const fileEnv = parseJsonObject(await readOptional(io, path.join(io.homedir, '.claude', 'settings.json'))).env
    const env = (fileEnv && typeof fileEnv === 'object' ? fileEnv : {}) as Record<string, unknown>
    const pick = (key: string) => {
      const fromFile = env[key]
      return (typeof fromFile === 'string' && fromFile.trim()) || io.env[key]?.trim() || ''
    }
    const apiKey = pick('ANTHROPIC_AUTH_TOKEN') || pick('ANTHROPIC_API_KEY')
    return apiKey ? buildEndpoint('claude', pick('ANTHROPIC_BASE_URL'), apiKey) : null
  }

  if (provider === 'codex') {
    const toml = (await readOptional(io, path.join(io.homedir, '.codex', 'config.toml'))) ?? ''
    const config = readCodexProviderConfig(toml)
    const auth = parseJsonObject(await readOptional(io, path.join(io.homedir, '.codex', 'auth.json')))
    const envKeyValue = config.provider?.envKey ? io.env[config.provider.envKey]?.trim() : ''
    const authKey = typeof auth.OPENAI_API_KEY === 'string' ? auth.OPENAI_API_KEY.trim() : ''
    const apiKey = envKeyValue || authKey || io.env.OPENAI_API_KEY?.trim() || ''
    return apiKey ? buildEndpoint('codex', config.provider?.baseUrl ?? '', apiKey) : null
  }

  return null
}

const fetchModelIds = async (endpoint: ModelDiscoveryEndpoint) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), discoveryTimeoutMs)
  try {
    const response = await fetch(endpoint.url, { headers: endpoint.headers, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseModelListIds(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

export const discoverProviderModels = async (
  settings: AppSettings,
  io: ModelDiscoveryIo = defaultIo,
): Promise<ProviderModelDiscovery[]> => {
  const providers: Provider[] = ['claude', 'codex', 'gemini']
  const results = await Promise.all(
    providers.map(async (provider): Promise<ProviderModelDiscovery | null> => {
      const endpoint = await resolveModelDiscoveryEndpoint(provider, settings, io)
      if (!endpoint) return null
      try {
        return { provider, ids: await fetchModelIds(endpoint) }
      } catch (error) {
        return { provider, ids: [], error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
  return results.filter((entry): entry is ProviderModelDiscovery => entry !== null)
}

