#!/usr/bin/env node
// 真实 CLI 端到端：用 Chill Vibe 自己的参数构建器起 Claude / Codex，验证浏览器控制 MCP 真的进了工具表。
//
// 用法：node --import tsx scripts/verify-computer-use-e2e.mjs [--skip-claude] [--skip-codex] [--codex-model gpt-5.5]
//
// - Claude：buildClaudeArgs({ computerUseEnabled: true }, { computerUseMcpConfig }) → `claude -p --max-turns 1 --output-format json`
//   让模型只列出 mcp__ 开头的工具名（会花一次真实调用）。判据：结果里出现 mcp__chill_vibe_browser__。
// - Codex：buildComputerUseCodexRuntimeArgs(launch) → `codex exec -c model_providers.probe=...` 指向本地捕获服务器，
//   抓第一条 /v1/responses 请求体（返回 500，不花钱）。判据：tool_search 描述里列出 chill_vibe_browser。
//   （Codex 0.153 把 MCP 工具延迟在 tool_search 后面，顶层 tools 里看不到，见 pitfall #383。）
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildClaudeArgs } from '../server/providers.ts'
import {
  buildComputerUseClaudeMcpConfig,
  buildComputerUseCodexRuntimeArgs,
  computerUseMcpServerName,
  resolveBrowserMcpLaunch,
} from '../server/computer-use-runtime.ts'
import { defaultSystemPrompt } from '../shared/system-prompt.ts'

const argv = process.argv.slice(2)
const skipClaude = argv.includes('--skip-claude')
const skipCodex = argv.includes('--skip-codex')
const codexModelIndex = argv.indexOf('--codex-model')
const codexModel = codexModelIndex >= 0 ? argv[codexModelIndex + 1] : 'gpt-5.5'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Windows 上不能走 shell:true：cmd 会把 --settings / -c 里的双引号剥掉（探针脚本同款坑）。
// 直接定位 npm shim 背后的真实入口：claude 是原生 exe，codex 是 node 脚本。
const resolveWindowsEntry = (shimName, relative) => {
  const shim = execFileSync('where', [shimName], { encoding: 'utf8' })
    .split(os.EOL)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  const entry = shim ? path.join(path.dirname(shim), 'node_modules', ...relative) : ''
  if (!entry || !existsSync(entry)) throw new Error(`找不到 ${shimName} 的 npm 入口（where ${shimName} → ${shim ?? '无'}）`)
  return entry
}
const claudeLauncher = process.platform === 'win32'
  ? { command: resolveWindowsEntry('claude', ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe']), prefixArgs: [] }
  : { command: 'claude', prefixArgs: [] }
const codexLauncher = process.platform === 'win32'
  ? { command: process.execPath, prefixArgs: [resolveWindowsEntry('codex', ['@openai', 'codex', 'bin', 'codex.js'])] }
  : { command: 'codex', prefixArgs: [] }

const launch = await resolveBrowserMcpLaunch()
if (!launch) {
  console.error('resolveBrowserMcpLaunch() 返回 null：本机既没有全局 @playwright/mcp 也没有 npx。')
  process.exit(2)
}
console.log(`browser MCP launch: ${launch.command} ${launch.args.join(' ')} env=${JSON.stringify(launch.env)}`)

const run = (command, args, { input, cwd, timeoutMs = 180_000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd ?? repoRoot,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}` })
    })
    if (input !== undefined) {
      child.stdin.end(input)
    }
  })

const results = {}

if (!skipClaude) {
  const request = {
    provider: 'claude',
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
    computerUseEnabled: true,
  }
  const args = buildClaudeArgs(request, [], {
    computerUseMcpConfig: buildComputerUseClaudeMcpConfig(launch),
  })
  const prompt = '只回答一行：列出你当前工具表里名字以 mcp__ 开头的全部工具名（逗号分隔），没有就回答 NONE。不要调用任何工具。'
  const { code, stdout, stderr } = await run(
    claudeLauncher.command,
    [...claudeLauncher.prefixArgs, '-p', '--max-turns', '1', '--output-format', 'json', ...args],
    { input: prompt },
  )
  let text = stdout
  try {
    text = String(JSON.parse(stdout).result ?? stdout)
  } catch {
    // 非 JSON 直接看原文
  }
  const ok = text.includes(`mcp__${computerUseMcpServerName}__`)
  results.claude = { ok, code, sample: text.slice(0, 300), stderr: stderr.slice(-300) }
  console.log(`claude: ${ok ? 'PASS' : 'FAIL'} (exit ${code})\n  ${text.slice(0, 300)}`)
  if (!ok && stderr) console.log(`  stderr: ${stderr.slice(-300)}`)
}

if (!skipCodex) {
  const captured = await new Promise((resolve, reject) => {
    let body = null
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (body === null && req.url?.includes('/responses')) body = raw
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end('{"error":{"message":"probe"}}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const provider = `model_providers.probe={name="probe",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false}`
      const child = spawn(
        codexLauncher.command,
        [
          ...codexLauncher.prefixArgs,
          'exec', '--skip-git-repo-check', '-C', repoRoot,
          '-c', provider, '-c', 'model_provider="probe"', '-c', `model="${codexModel}"`,
          '-c', 'approval_policy="never"', '--sandbox', 'read-only',
          ...buildComputerUseCodexRuntimeArgs(launch),
          'hi',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const timer = setTimeout(() => child.kill(), 60_000)
      child.on('close', () => {
        clearTimeout(timer)
        server.close()
        if (body === null) reject(new Error(`codex 没有发出 /responses 请求。stderr:\n${stderr.slice(-600)}`))
        else resolve(body)
      })
    })
  }).catch((error) => {
    console.log(`codex: FAIL ${error.message}`)
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
    const direct = all.some((tool) => String(tool.name ?? '').includes(computerUseMcpServerName))
    const ok = direct || description.includes(computerUseMcpServerName)
    results.codex = { ok, direct, sample: description.split('\n').filter((line) => line.startsWith('- ')).join(' | ') }
    console.log(`codex: ${ok ? 'PASS' : 'FAIL'} (${direct ? '顶层工具直出' : 'tool_search 来源'})\n  ${results.codex.sample}`)
  }
}

const failed = Object.values(results).some((entry) => !entry.ok)
process.exit(failed ? 1 : 0)
