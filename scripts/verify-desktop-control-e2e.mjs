#!/usr/bin/env node
// 真实端到端：用 Chill Vibe 自己的构建器起 Windows-MCP / Claude / Codex，验证桌面操控 MCP 真的接上了。
//
// 用法：node --import tsx scripts/verify-desktop-control-e2e.mjs [--skip-claude] [--skip-codex] [--codex-model gpt-5.5]
//
// - MCP 直连：按 createDesktopControlRuntime 解析出的命令起 stdio server，initialize + tools/list。
//   判据：有 Screenshot / Click / Snapshot，没有 PowerShell / FileSystem / Process / Registry。
// - Claude：buildClaudeArgs + 合并后的 --mcp-config 起 `claude -p --output-format stream-json --verbose`，
//   只读第一条 system/init 就杀进程（不等模型回答）。判据：mcp_servers 里 chill_vibe_desktop 为 connected。
// - Codex：同 verify-computer-use-e2e 的捕获服务器，抓第一条 /v1/responses（返回 500，不花钱）。
//   判据：tool_search 描述里列出 chill_vibe_desktop。
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildClaudeArgs } from '../server/providers.ts'
import {
  createDesktopControlRuntime,
  desktopControlExcludedTools,
  desktopControlMcpServerName,
} from '../server/desktop-control-runtime.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'

const argv = process.argv.slice(2)
const skipClaude = argv.includes('--skip-claude')
const skipCodex = argv.includes('--skip-codex')
const codexModelIndex = argv.indexOf('--codex-model')
const codexModel = codexModelIndex >= 0 ? argv[codexModelIndex + 1] : 'gpt-5.5'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const resolveWindowsEntry = (shimName, relative) => {
  const shim = execFileSync('where', [shimName], { encoding: 'utf8' })
    .split(os.EOL)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const entry = shim ? path.join(path.dirname(shim), 'node_modules', ...relative) : ''
  if (!entry || !existsSync(entry)) throw new Error(`找不到 ${shimName} 的 npm 入口（where ${shimName} → ${shim ?? '无'}）`)
  return entry
}

const baseRequest = {
  workspacePath: repoRoot,
  model: 'claude-opus-5',
  reasoningEffort: 'low',
  thinkingEnabled: false,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: defaultSystemPrompt,
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
  prompt: '',
  attachments: [],
  desktopControlEnabled: true,
}

const claudeRuntime = await createDesktopControlRuntime({ ...baseRequest, provider: 'claude' })
const codexRuntime = await createDesktopControlRuntime({ ...baseRequest, provider: 'codex' })
if (!claudeRuntime || !codexRuntime) {
  console.error('createDesktopControlRuntime() 返回 null：本机找不到 windows-mcp / uvx / uv，或不是 Windows。')
  process.exit(2)
}
const server = claudeRuntime.claudeMcpConfig.mcpServers[desktopControlMcpServerName]
console.log(`desktop MCP launch: ${server.command} ${server.args.join(' ')}`)

const results = {}

// ---- MCP 直连 ----
{
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        pending.get(message.id)?.(message)
      } catch {
        // 非 JSON 行忽略
      }
    }
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const call = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 120_000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  try {
    await call(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'chill-vibe-e2e', version: '0' },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const list = await call(2, 'tools/list', {})
    const names = (list.result?.tools ?? []).map((tool) => tool.name)
    const required = ['Screenshot', 'Snapshot', 'Click', 'Type']
    const ok = required.every((name) => names.includes(name))
      && desktopControlExcludedTools.every((name) => !names.includes(name))
    results.mcp = { ok, names }
    console.log(`mcp: ${ok ? 'PASS' : 'FAIL'}\n  tools: ${names.join(', ')}`)
  } catch (error) {
    results.mcp = { ok: false }
    console.log(`mcp: FAIL ${error.message}\n  stderr: ${stderr.slice(-600)}`)
  } finally {
    child.kill()
  }
}

// ---- Claude ----
if (!skipClaude) {
  const claudeExe = process.platform === 'win32'
    ? resolveWindowsEntry('claude', ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'])
    : 'claude'
  const args = buildClaudeArgs({ ...baseRequest, provider: 'claude' }, [], {
    computerUseMcpConfig: claudeRuntime.claudeMcpConfig,
  })
  const init = await new Promise((resolve) => {
    const child = spawn(claudeExe, ['-p', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', ...args], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let buffer = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      child.kill()
      resolve(value)
    }
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      for (const line of buffer.split('\n')) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'system' && event.subtype === 'init') finish(event)
        } catch {
          // 半行，等下一块
        }
      }
    })
    child.on('close', () => finish(null))
    setTimeout(() => finish(null), 180_000)
    child.stdin.end('hi')
  })
  const status = init?.mcp_servers?.find((entry) => entry.name === desktopControlMcpServerName)?.status
  const toolCount = (init?.tools ?? []).filter((name) => name.startsWith(`mcp__${desktopControlMcpServerName}__`)).length
  const ok = status === 'connected' && toolCount > 0
  results.claude = { ok, status, toolCount }
  console.log(`claude: ${ok ? 'PASS' : 'FAIL'} (status=${status ?? 'missing'}, ${toolCount} 个 mcp__${desktopControlMcpServerName}__ 工具)`)
}

// ---- Codex ----
if (!skipCodex) {
  const codexEntry = process.platform === 'win32'
    ? { command: process.execPath, prefixArgs: [resolveWindowsEntry('codex', ['@openai', 'codex', 'bin', 'codex.js'])] }
    : { command: 'codex', prefixArgs: [] }
  const captured = await new Promise((resolve, reject) => {
    let body = null
    const probe = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (body === null && req.url?.includes('/responses')) body = raw
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"probe"}}')
      })
    })
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      const provider = `model_providers.probe={name="probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`
      const child = spawn(
        codexEntry.command,
        [
          ...codexEntry.prefixArgs,
          'exec', '--skip-git-repo-check', '-C', repoRoot,
          '-c', provider, '-c', 'model_provider="probe"', '-c', `model="${codexModel}"`,
          '-c', 'approval_policy="never"', '--sandbox', 'read-only',
          ...codexRuntime.codexRuntimeArgs,
          'hi',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const timer = setTimeout(() => child.kill(), 150_000)
      child.on('close', () => {
        clearTimeout(timer)
        probe.close()
        if (body === null) reject(new Error(`codex 没有发出 /responses 请求。stderr:\n${stderr.slice(-600)}`))
        else resolve(body)
      })
    })
  }).catch((error) => {
    console.log(`codex: FAIL ${error.message}`)
    results.codex = { ok: false }
    return null
  })

  if (captured) {
    const request = JSON.parse(captured)
    const all = []
    const walk = (tools) => {
      for (const tool of tools ?? []) {
        all.push(tool)
        if (Array.isArray(tool.tools)) walk(tool.tools)
      }
    }
    walk(request.tools)
    for (const item of request.input ?? []) if (item.type === 'additional_tools') walk(item.tools)
    const toolSearch = all.find((tool) => (tool.name ?? tool.type) === 'tool_search')
    const description = String(toolSearch?.description ?? '')
    const direct = all.some((tool) => String(tool.name ?? '').includes(desktopControlMcpServerName))
    const ok = direct || description.includes(desktopControlMcpServerName)
    results.codex = { ok, direct }
    console.log(`codex: ${ok ? 'PASS' : 'FAIL'} (${direct ? '顶层工具直出' : 'tool_search 来源'})\n  ${description.split('\n').filter((line) => line.startsWith('- ')).join(' | ')}`)
  }
}

const failed = Object.values(results).some((entry) => !entry.ok)
process.exit(failed ? 1 : 0)
