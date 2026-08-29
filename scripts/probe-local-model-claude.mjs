// 端到端验证：走 chill-vibe 真实的 resolveProviderRuntime + buildClaudeArgs 链路，
// 起真的 claude CLI，用透明代理观测请求是否落到本地模型条目配置的端点。
//
// 这个脚本存在的理由：单元测试只能证明 argv 里写对了 `--settings`，证明不了 CLI 真的
// 听它的。2026-08-29 的根因（用户 ~/.claude/settings.json 的 env 覆盖进程环境变量）
// 恰恰只在真实 CLI 上才暴露 —— 代理侧「收到 0 个请求」是唯一能坐实它的证据。
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PROXY_PORT = 11499
const OLLAMA = { host: '127.0.0.1', port: 11434 }
const seen = []

const proxy = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    seen.push(`${req.method} ${req.url} len=${body.length}`)
    console.log('PROXY <<', req.method, req.url, 'len=', body.length)
    const up = http.request(
      {
        ...OLLAMA,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${OLLAMA.host}:${OLLAMA.port}` },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', (e) => {
      console.log('PROXY !! upstream', e.message)
      res.writeHead(502).end()
    })
    if (body.length) up.write(body)
    up.end()
  })
})

const main = async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-e2e-'))
  process.env.CHILL_VIBE_DATA_DIR = tmpDir

  const { createDefaultState } = await import('../shared/default-state.ts')
  const { saveState } = await import('../server/state-store.ts')
  const { resolveProviderRuntime, buildClaudeArgs } = await import('../server/providers.ts')
  const { defaultSystemPrompt } = await import('../shared/system-prompt.ts')

  const state = createDefaultState('')
  state.settings.cliRoutingEnabled = true
  state.settings.resilientProxyEnabled = false
  state.settings.localModelEntries = [
    {
      id: 'local-e2e',
      label: 'Ollama qwen (e2e)',
      harness: 'claude',
      baseUrl: `http://127.0.0.1:${PROXY_PORT}`,
      apiKey: '',
      model: 'qwen3:0.6b',
    },
  ]
  await saveState(state)

  const runtime = await resolveProviderRuntime('claude', { localModelId: 'local-e2e' })
  console.log('runtime.env ANTHROPIC_BASE_URL =', runtime.env.ANTHROPIC_BASE_URL)
  console.log('runtime.claudeSettingsEnv     =', JSON.stringify(runtime.claudeSettingsEnv))

  const request = {
    provider: 'claude',
    workspacePath: process.cwd(),
    model: 'qwen3:0.6b',
    reasoningEffort: 'medium',
    thinkingEnabled: true,
    planMode: false,
    language: 'zh-CN',
    systemPrompt: defaultSystemPrompt,
    modelPromptRules: [],
    crossProviderSkillReuseEnabled: true,
    prompt: '只回复两个字：收到',
    attachments: [],
  }

  const args = [
    ...runtime.args,
    ...buildClaudeArgs(request, [], {
      includeEffort: true,
      settingsEnvOverride: runtime.claudeSettingsEnv,
    }),
  ]

  const settingsIndex = args.indexOf('--settings')
  console.log('--settings.env =', JSON.stringify(JSON.parse(args[settingsIndex + 1]).env))

  await new Promise((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))
  console.log(`proxy up on ${PROXY_PORT} -> ollama ${OLLAMA.port}`)
  console.log('note: 用户 ~/.claude/settings.json 里有 duckcoding 的 env，正是要压制的对象')

  // 必须 shell:false —— `--settings` 的值是一整段 JSON，走 shell 会被引号规则吃掉，
  // 表现为 "Invalid JSON provided to --settings"。真实的 spawnProvider 同样不带 shell。
  const claudeExe =
    process.env.CLAUDE_CODE_EXECPATH ||
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe')
  const childEnv = { ...runtime.env }
  // 清掉本会话的父级标记，避免 CLI 以为自己是嵌套子会话。
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('CLAUDE_CODE_')) delete childEnv[key]
  }
  const child = spawn(claudeExe, args, { env: childEnv, cwd: process.cwd() })
  let sawAuthError = false
  let sawContent = false
  child.stdout.on('data', (d) => {
    const s = d.toString()
    if (s.includes('api_retry') || s.includes('authentication_failed')) sawAuthError = true
    if (s.includes('text_delta') || s.includes('thinking_delta')) sawContent = true
  })
  child.stderr.on('data', (d) => {
    const s = d.toString().trim()
    if (s && !s.startsWith('Warning: no stdin')) console.log('ERR:', s.slice(0, 300))
  })

  const finish = async (how) => {
    console.log(`\n=== ${how} ===`)
    console.log('proxy saw', seen.length, 'requests:')
    seen.forEach((s) => console.log('  ', s))
    console.log('auth error seen:', sawAuthError)
    console.log('streamed content:', sawContent)
    const ok = seen.some((s) => s.includes('/v1/messages')) && !sawAuthError && sawContent
    console.log(ok ? '\nRESULT: PASS — 请求确实落到本地端点' : '\nRESULT: FAIL')
    proxy.close()
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    process.exit(ok ? 0 : 1)
  }

  child.on('exit', (code) => finish(`CLI exited code=${code}`))
  setTimeout(() => {
    child.kill()
    finish('TIMEOUT 60s')
  }, 60000)
}

main()
