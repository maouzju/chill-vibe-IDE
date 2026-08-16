#!/usr/bin/env node
// 两台机器「同一个服务商、同一个 key、同一个模型，一个能用一个不能用」时，在两边各跑一次
// 然后逐行对比。它只读配置并发一次最小请求，不改任何东西；密钥一律打码。
//
// 用法：node scripts/diagnose-codex-config.mjs [model]
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const mask = (value) => {
  if (typeof value !== 'string' || !value) return '(none)'
  const trimmed = value.trim()
  return trimmed.length <= 14 ? `${trimmed.slice(0, 4)}…` : `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`)

const unquote = (value) => value?.replace(/^\s*["']|["']\s*$/g, '').trim()

// 极简 TOML 分节：按行扫，遇到 `[section]` 就切换归属。不用正则跨行截取——`$` 在多行模式下
// 会立刻匹配行尾，把整段吃成空字符串（本脚本第一版就栽在这）。
const parseTomlSections = (text) => {
  const sections = new Map([['', new Map()]])
  let current = ''

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const header = /^\[(.+?)\]$/.exec(trimmed)
    if (header) {
      current = header[1].trim()
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }

    const pair = /^([\w.-]+)\s*=\s*(.+)$/.exec(trimmed)
    if (pair) sections.get(current).set(pair[1], pair[2].trim())
  }

  return sections
}

const codexHome = process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
const configPath = path.join(codexHome, 'config.toml')
const authPath = path.join(codexHome, 'auth.json')

console.log('=== codex CLI ===')
try {
  line('version', execFileSync('codex', ['--version'], { encoding: 'utf8', shell: true }).trim())
} catch {
  line('version', '!! codex not found on PATH')
}
line('CODEX_HOME', codexHome)

console.log('\n=== ~/.codex/config.toml ===')
if (!existsSync(configPath)) {
  line('config.toml', '!! missing')
} else {
  const sections = parseTomlSections(readFileSync(configPath, 'utf8'))
  const root = sections.get('')
  const providerName = unquote(root.get('model_provider'))
  line('model_provider', providerName || '(not set at top level)')
  line('model', unquote(root.get('model')) || '(not set at top level)')

  if (providerName) {
    const block = sections.get(`model_providers.${providerName}`) ?? new Map()
    line('  base_url', unquote(block.get('base_url')) || '(none)')
    line('  wire_api', unquote(block.get('wire_api')) || '(default)')
    line('  env_key', unquote(block.get('env_key')) || '(default OPENAI_API_KEY)')
  }

  // 顶层键写在某个 [table] 之后是常见事故：TOML 会把它们算成那个表的字段，于是静默失效。
  const strays = ['approval_policy', 'sandbox_mode', 'model_reasoning_effort'].filter(
    (key) => !root.has(key) && [...sections].some(([name, keys]) => name && keys.has(key)),
  )
  if (strays.length) {
    line('!! swallowed by a table', `${strays.join(', ')} — 这些顶层设置没有生效`)
  }
}

console.log('\n=== auth ===')
line('auth.json OPENAI_API_KEY', mask(readJson(authPath)?.OPENAI_API_KEY))
line('env OPENAI_API_KEY', mask(process.env.OPENAI_API_KEY))
line('env OPENAI_BASE_URL', process.env.OPENAI_BASE_URL?.trim() || '(none)')

console.log('\n=== Chill Vibe 接口配置（会覆盖上面的 config.toml）===')
const dataDir =
  process.env.CHILL_VIBE_DATA_DIR?.trim() ||
  path.join(process.env.APPDATA || path.join(homedir(), '.config'), 'chill-vibe-ide', 'data')
const state = readJson(path.join(dataDir, 'state.json'))
if (!state) {
  line('state.json', `!! not readable at ${dataDir}`)
} else {
  const settings = state.settings ?? {}
  const routing = settings.cliRoutingEnabled === true
  line('cliRoutingEnabled', String(routing))
  line('resilientProxyEnabled', String(settings.resilientProxyEnabled === true))
  line('requestModels.codex', settings.requestModels?.codex || '(empty → built-in default)')
  const pool = settings.providerProfiles?.codex
  const active = pool?.profiles?.find((entry) => entry.id === pool?.activeProfileId)
  line('active profile', active ? active.name : '(none)')
  line('  baseUrl', active?.baseUrl || '(none)')
  line('  apiKey', mask(active?.apiKey))
  console.log(
    routing
      ? '  → 生效的是上面这个 baseUrl/apiKey，config.toml 的 provider 被覆盖。'
      : '  → 接口配置未启用，实际生效的是 config.toml 的 provider。',
  )
}

const model = process.argv[2] || state?.settings?.requestModels?.codex || 'gpt-5.6-sol'
console.log(`\n=== 实测一次最小请求 (model=${model}) ===`)

const probe = async () => {
  const routing = state?.settings?.cliRoutingEnabled === true
  const pool = state?.settings?.providerProfiles?.codex
  const active = pool?.profiles?.find((entry) => entry.id === pool?.activeProfileId)
  const sections = existsSync(configPath)
    ? parseTomlSections(readFileSync(configPath, 'utf8'))
    : new Map([['', new Map()]])
  const providerName = unquote(sections.get('')?.get('model_provider'))
  const tomlBase = providerName
    ? unquote(sections.get(`model_providers.${providerName}`)?.get('base_url'))
    : undefined

  const baseUrl = (routing ? active?.baseUrl : tomlBase) || tomlBase
  const apiKey = (routing ? active?.apiKey : readJson(authPath)?.OPENAI_API_KEY) || readJson(authPath)?.OPENAI_API_KEY

  if (!baseUrl || !apiKey) {
    console.log('跳过：没有解析出可用的 baseUrl/apiKey。')
    return
  }

  line('POST', `${baseUrl.replace(/\/$/, '')}/responses`)
  line('with key', mask(apiKey))

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: 'hi', store: false, stream: false }),
  }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }))

  const body = await response.text()
  line('HTTP', String(response.status))
  console.log(body.length > 400 ? `${body.slice(0, 400)}…` : body)
}

probe().catch((error) => {
  console.error('probe failed:', error.message)
  process.exitCode = 1
})
