#!/usr/bin/env node
// 抓 Codex CLI 真正发给模型的工具定义（不靠文档、不靠模型自述）。
//
// 用法：node scripts/probe-codex-tool-schema.mjs [--model gpt-6-astra] [--tool spawn_agent] [-c key=value ...]
//
// 原理：起一个本地 HTTP 捕获服务器，用 `-c model_providers.probe=...` 把 codex exec 指过来，
// 拿到第一条 /v1/responses 请求体后直接回 500 让它放弃，然后打印工具表。
//
// 2026-09-21 实测的三个坑，改这个脚本前先看：
// 1. `tool_mode: "code_mode_only"` 的模型（gpt-6-astra / gpt-5.6-sol）请求体顶层没有 `tools`，
//    工具全塞在 `input[].type === "additional_tools"` 的 namespace 里，只看顶层会误判成"没工具"。
// 2. codex exec 不带 `</dev/null` 会卡在 "Reading additional input from stdin..."；这里显式 stdin=ignore。
// 3. 收到 500 后 codex 会重连 5 次，同一请求会被抓到多份，只取第一份。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const model = readFlag('--model', 'gpt-6-astra')
const toolName = readFlag('--tool', 'spawn_agent')
const extraConfig = []
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '-c' && argv[index + 1]) {
    extraConfig.push('-c', argv[index + 1])
    index += 1
  }
}

const resolveLauncher = () => {
  if (process.platform !== 'win32') return { command: 'codex', prefixArgs: [] }
  const shim = execFileSync('where', ['codex'], { encoding: 'utf8' })
    .split(os.EOL)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const entry = shim ? path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : ''
  if (!entry || !existsSync(entry)) throw new Error(`找不到 codex 的 npm 入口（where codex → ${shim ?? '无'}）`)
  return { command: process.execPath, prefixArgs: [entry] }
}
const launcher = resolveLauncher()

const captured = await new Promise((resolve, reject) => {
  let body = null
  const server = http.createServer((req, res) => {
    let chunks = ''
    req.on('data', (chunk) => (chunks += chunk))
    req.on('end', () => {
      if (body === null && req.url.endsWith('/responses')) body = chunks
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"probe-captured"}}')
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    const provider = `model_providers.probe={name="probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`
    // Windows 上不能走 shell:true——cmd 会把 TOML 内联表里的双引号剥掉，codex 报
    // `invalid type: string ..., expected struct ModelProviderInfo`。直接用 node 跑 npm shim 指向的 codex.js。
    const child = spawn(
      launcher.command,
      [
        ...launcher.prefixArgs,
        'exec', '--skip-git-repo-check', '-C', process.cwd(),
        '-c', provider, '-c', 'model_provider="probe"', '-c', `model="${model}"`,
        '-c', 'approval_policy="never"', '--sandbox', 'read-only',
        ...extraConfig,
        'hi',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), 45_000)
    child.on('close', () => {
      clearTimeout(timer)
      server.close()
      if (body === null) reject(new Error(`codex 没有发出任何 /responses 请求。stderr:\n${stderr.slice(-800)}`))
      else resolve(body)
    })
  })
})

const request = JSON.parse(captured)
const found = []
const walk = (tools, where) => {
  for (const tool of tools ?? []) {
    const name = tool.name ?? tool.type
    if (tool.name === toolName) found.push({ where, tool })
    if (Array.isArray(tool.tools)) walk(tool.tools, `${where}/${name}`)
  }
}
walk(request.tools, 'tools')
for (const item of request.input ?? []) {
  if (item.type === 'additional_tools') walk(item.tools, 'input.additional_tools')
}

const summarize = (tools, where) =>
  (tools ?? []).map((tool) => {
    const name = tool.name ?? tool.type
    return Array.isArray(tool.tools) ? `${name}{${summarize(tool.tools, where).join(', ')}}` : name
  })
console.log(`model: ${request.model}`)
console.log(`顶层 tools: ${summarize(request.tools).join(', ') || '(无——code_mode_only 模型工具在 input.additional_tools 里)'}`)
for (const item of request.input ?? []) {
  if (item.type === 'additional_tools') console.log(`input.additional_tools: ${summarize(item.tools).join(', ')}`)
}
if (found.length === 0) {
  console.log(`未找到工具 ${toolName}`)
  process.exit(1)
}
for (const { where, tool } of found) {
  const properties = tool.parameters?.properties ?? {}
  console.log(`\n[${where}] ${toolName} 参数: ${Object.keys(properties).join(', ')} | 必填: ${(tool.parameters?.required ?? []).join(', ')}`)
  for (const [key, schema] of Object.entries(properties)) {
    console.log(`  - ${key}: ${schema.description ?? JSON.stringify(schema)}`)
  }
  console.log(`  描述:\n${String(tool.description ?? '').trim().split('\n').map((line) => `    ${line}`).join('\n')}`)
}
