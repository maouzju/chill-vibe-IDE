import { mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { getAppDataDir, getDefaultWorkspacePath } from '../app-paths.js'
import { resolveCommand, resolveProviderRuntime } from '../providers.js'
import { resolveProviderCommandLaunch } from '../provider-command-launch.js'
import { createId, type NoiseLayer, type NoiseScene } from './whitenoise-store.js'
import { AUDIO_SOURCES } from './audio-cache.js'

const SYNTHESIZED_TYPES = new Set(['white', 'pink', 'brown'])

const SYSTEM_PROMPT = `You are an ambient soundscape designer. The user will describe a vibe or scene (or give no prompt, meaning you should invent a creative, unique one — never repeat the same scene).

Your job: decompose the scene into 2-5 audio layers. You may use ANY sound type that fits the scene — you are NOT limited to a fixed list.

Each layer has:
- generator: a short kebab-case identifier for the sound (e.g. "rain", "cat-purring", "temple-bell", "typing", "vinyl-crackle")
- label: short Chinese name for the sound (2-4 chars)
- volume: 0.0-1.0
- url: a DIRECT download URL to a CC0 / public-domain audio file (.mp3, .ogg, or .wav). The URL must point directly to the audio file, not a web page.

Special cases — these 3 types are synthesized client-side and do NOT need a url:
- white (白噪音), pink (粉噪音), brown (棕噪音)
However, DO NOT use these synthesized types. Always find real audio samples instead.

For ALL sound types, you MUST provide a valid url to a freely-downloadable audio file. Good sources:
- https://bigsoundbank.com/UPLOAD/mp3/{id}.mp3
- https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/{name}.mp3
- https://raw.githubusercontent.com/mateusfg7/Noisekun/main/.github/assets/sounds/{name}.ogg
- Other direct links to CC0/public-domain audio files

Rules:
- CRITICAL: Every layer must be logically consistent with the scene title and setting
- NEVER use white/pink/brown synthesized noise. Always use real audio samples with a download URL
- CRITICAL: Only use AMBIENT LOOP audio files that are at least 30 seconds long and designed for seamless looping. NEVER use short sound effects (animal calls, single notes, one-shot sounds) — they will loop badly and sound terrible. For example: use "crackling fireplace loop" not "single fire ignite"; use "cat purring loop" not "single meow"
- NEVER use animal vocalizations (barking, howling, screaming, etc.) as these sound jarring on repeat. Only use gentle continuous sounds (purring, ambient birdsong, cricket chorus, etc.)
- Choose sounds that promote focus, calm, and comfort — never jarring or distracting
- Vary volumes so layers blend naturally (not all at the same level)
- Give the scene a short evocative Chinese title (≤10 chars)
- Be creative — each scene should feel distinct

Respond with ONLY valid JSON, no markdown fences, no explanation:
{"title":"场景标题","layers":[{"generator":"rain","label":"细雨","volume":0.6,"url":"https://raw.githubusercontent.com/bradtraversy/ambient-sound-mixer/main/audio/rain.mp3"}]}`

function sanitizeGeneratorName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

function isValidAudioUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function parseSceneResponse(raw: string): { title: string; layers: NoiseLayer[] } {
  // Strip markdown fences if AI includes them despite instruction
  const cleaned = raw.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  const parsed = JSON.parse(cleaned) as { title?: string; layers?: Array<{ generator?: string; label?: string; volume?: number; url?: string }> }

  const title = typeof parsed.title === 'string' ? parsed.title.slice(0, 20) : '白噪音场景'
  const layers: NoiseLayer[] = []

  for (const item of parsed.layers ?? []) {
    const gen = sanitizeGeneratorName(String(item.generator ?? ''))
    if (!gen) continue

    const url = typeof item.url === 'string' && isValidAudioUrl(item.url) ? item.url : undefined

    // If no URL and not synthesized and not in legacy sources, skip
    if (!url && !SYNTHESIZED_TYPES.has(gen) && !AUDIO_SOURCES[gen]) continue

    layers.push({
      id: createId(),
      label: typeof item.label === 'string' ? item.label.slice(0, 10) : gen,
      generator: gen,
      volume: Math.max(0, Math.min(1, Number(item.volume) || 0.5)),
      url,
    })
  }

  return { title, layers: layers.slice(0, 5) }
}

const isDirectory = async (targetPath: string) => {
  try {
    const info = await stat(targetPath)
    return info.isDirectory()
  } catch {
    return false
  }
}

export const resolveWhitenoiseCliCwd = async ({
  defaultWorkspacePath = getDefaultWorkspacePath(),
  appDataDir = getAppDataDir(),
}: {
  defaultWorkspacePath?: string
  appDataDir?: string
} = {}) => {
  const normalizedWorkspacePath = defaultWorkspacePath.trim()

  if (normalizedWorkspacePath && await isDirectory(normalizedWorkspacePath)) {
    return normalizedWorkspacePath
  }

  await mkdir(appDataDir, { recursive: true })
  return appDataDir
}

// 症状：白噪音生成会拉起一个完全不受沙箱约束、且没有任何超时/输出上限的 codex 子进程，
// 挂住时整条 IPC 调用永久悬挂（generateScene 的 promise 只在 close/error 才落定）。
// 根因：argv 里写死了全仓库唯一一处 `--dangerously-bypass-approvals-and-sandbox`，而 cwd 又优先
// 指向用户真实工作区（resolveWhitenoiseCliCwd）——一个"只要模型吐一段 JSON"的功能拿到了写全盘的权限。
// 被否决的替代方案：沿用 bypass 只加超时。read-only 才是这类纯生成任务的既定选择
// （先例：BrainstormCard.tsx / git-operation-hub.ts 都显式传 sandboxMode: 'read-only'，
// buildCodexArgs 从不发 bypass，tests/provider-system-prompt.test.ts 已对主聊天路径钉死该禁令）。
export const buildWhitenoiseCliArgs = (
  provider: 'claude' | 'codex',
  prompt: string,
  runtimeArgs: string[] = [],
): string[] => {
  if (provider === 'claude') {
    return [...runtimeArgs, '-p', '--output-format', 'text', '--max-turns', '1', prompt]
  }

  // 症状：codex-cli 0.144.1 下这条 argv 起不来，stderr 只有一行 unexpected argument
  //       （2026-08-14 实测 `--ask-for-approval` 与 `-q` 双双报废），白噪音 codex 分支 100% 挂。
  // 根因：exec 本就非交互，这两个开关一直是空操作，0.144 把它们从 exec 删了。
  // 为什么审批策略改走 `-c` 而不是直接不传：用户 config.toml 的 approval_policy 可能是别的值，
  //       这条"只要一段 JSON"的调用必须继续钉死 never；`-c` 覆盖新旧 CLI 都认。
  const args = [...runtimeArgs, 'exec', '--json', '--skip-git-repo-check']
  args.push('-c', 'approval_policy="never"')
  args.push('--sandbox', 'read-only')
  args.push(prompt)
  return args
}

// 单次「拿一段 JSON」的 CLI 调用不该比一次普通聊天回合还久；沿用 providers.ts 的
// getLocalProviderTimeoutMs 解析口径（非法/过小值回退默认），命名跟随 CHILL_VIBE_*_TIMEOUT_MS。
export const WHITENOISE_CLI_DEFAULT_TIMEOUT_MS = 120_000

// stdout/stderr 曾是无界字符串累加：一个跑飞的 CLI 能把主进程内存吃穿。
export const WHITENOISE_CLI_MAX_OUTPUT_CHARS = 262_144

export const getWhitenoiseCliTimeoutMs = (): number => {
  const parsed = Number.parseInt(process.env.CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(parsed) && parsed >= 50) {
    return parsed
  }

  return WHITENOISE_CLI_DEFAULT_TIMEOUT_MS
}

const createBoundedText = (maxChars: number) => {
  let value = ''

  return {
    append(chunk: string) {
      if (value.length >= maxChars) return
      value += chunk.slice(0, maxChars - value.length)
    },
    get value() {
      return value
    },
  }
}

// 逐行扫描而不是把整个 stdout 拼成字符串再倒着切（模板：readCodexManagementPolicy 的 readline 解析）。
// 这样输出封顶后仍然能拿到答案：命中的 assistant 文本在流过来的当下就被摘出来了。
const createLineScanner = (onLine: (line: string) => void, maxLineChars: number) => {
  let pending = ''
  let overflowed = false

  const flushLine = (line: string) => {
    if (line) onLine(line)
  }

  return {
    push(chunk: string) {
      let rest = chunk
      let newlineIndex = rest.indexOf('\n')

      while (newlineIndex >= 0) {
        const line = pending + rest.slice(0, newlineIndex)
        pending = ''
        if (!overflowed) flushLine(line.trim())
        overflowed = false
        rest = rest.slice(newlineIndex + 1)
        newlineIndex = rest.indexOf('\n')
      }

      pending += rest
      if (pending.length > maxLineChars) {
        // 单行也可能无界（巨型 JSON 事件）：丢弃这一行的剩余部分，等下一个换行符重新对齐。
        pending = ''
        overflowed = true
      }
    },
    end() {
      if (!overflowed) flushLine(pending.trim())
      pending = ''
      overflowed = false
    },
  }
}

const extractCodexSceneText = (line: string): string | null => {
  let event: {
    type?: string
    role?: string
    content?: unknown
    response?: { output?: Array<{ type?: string; content?: unknown }> }
  }

  try {
    event = JSON.parse(line)
  } catch {
    return null
  }

  if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
    return event.content
  }

  // Also handle response.completed format
  if (event.type === 'response.completed' && event.response?.output) {
    for (const item of event.response.output) {
      if (item.type === 'message' && typeof item.content === 'string') {
        return item.content
      }
      if (Array.isArray(item.content)) {
        const text = item.content
          .filter((c: { type?: string; text?: string }) => c.type === 'output_text' || c.type === 'text')
          .map((c: { text?: string }) => c.text ?? '')
          .join('')
        if (text) {
          return text
        }
      }
    }
  }

  return null
}

export type WhitenoiseCliChild = {
  stdout: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown } | null
  stderr: { on: (event: 'data', listener: (chunk: Buffer) => void) => unknown } | null
  on: {
    (event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
    (event: 'error', listener: (error: Error) => void): unknown
  }
  kill: (signal?: NodeJS.Signals) => unknown
}

export type WhitenoiseCliSpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: boolean
  },
) => WhitenoiseCliChild

const defaultSpawn: WhitenoiseCliSpawn = (command, args, options) => spawn(command, args, options)

// 进程监管模板照抄 readCodexManagementPolicy：settled latch + finish() 里 clearTimeout/kill/只落定一次，
// 硬超时、error 与 close 都走 finish，所以子进程再怎么挂也不会让 promise 悬空。
export const runWhitenoiseCliProcess = ({
  provider,
  launch,
  cwd,
  env,
  timeoutMs = getWhitenoiseCliTimeoutMs(),
  maxOutputChars = WHITENOISE_CLI_MAX_OUTPUT_CHARS,
  spawnProcess = defaultSpawn,
}: {
  provider: 'claude' | 'codex'
  launch: { command: string; args: string[] }
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  maxOutputChars?: number
  spawnProcess?: WhitenoiseCliSpawn
}): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let settled = false
    let child: WhitenoiseCliChild | undefined

    const finish = (error: Error | null, value = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child?.kill()
      if (error) {
        reject(error)
        return
      }
      resolve(value)
    }

    const timer = setTimeout(
      () => finish(new Error(`${provider} CLI timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )

    const stdout = createBoundedText(maxOutputChars)
    const stderr = createBoundedText(maxOutputChars)
    let sceneText: string | null = null
    const lines = createLineScanner((line) => {
      const extracted = extractCodexSceneText(line)
      if (extracted !== null) {
        sceneText = extracted.slice(0, maxOutputChars)
      }
    }, maxOutputChars)

    try {
      child = spawnProcess(launch.command, launch.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish(new Error(`Failed to spawn ${provider} CLI: ${error instanceof Error ? error.message : String(error)}`))
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout.append(text)
      if (provider === 'codex') {
        lines.push(text)
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.append(chunk.toString())
    })

    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`${provider} CLI exited with code ${code}: ${stderr.value.slice(0, 200)}`))
        return
      }

      if (provider === 'codex') {
        lines.end()
        // Codex --json outputs newline-delimited JSON events; the last assistant message wins.
        finish(null, sceneText ?? stdout.value.trim())
        return
      }

      // Claude --output-format text returns plain text
      finish(null, stdout.value.trim())
    })

    child.on('error', (error) => {
      finish(new Error(`Failed to spawn ${provider} CLI: ${error.message}`))
    })
  })

async function callViaCli(provider: 'claude' | 'codex', userPrompt: string): Promise<string> {
  const command = await resolveCommand(provider)
  if (!command) {
    throw new Error(`${provider} CLI not found`)
  }

  const runtime = await resolveProviderRuntime(provider)
  const defaultPrompts = [
    '雨天窗边读书', '深山溪流旁冥想', '海边日落散步',
    '冬夜壁炉旁', '夏日午后森林', '咖啡馆角落写作',
    '雷雨天阁楼', '春天鸟鸣花园', '篝火旁露营',
    '图书馆安静自习', '列车窗边看雨', '午夜城市天台',
  ]
  const fallback = defaultPrompts[Math.floor(Math.random() * defaultPrompts.length)]!
  const prompt = `${SYSTEM_PROMPT}\n\nUser: ${userPrompt || `随机生成一个白噪音场景，灵感参考：${fallback}（请自由发挥，不必完全照搬）`}`

  const args = buildWhitenoiseCliArgs(provider, prompt, runtime.args)
  const launch = await resolveProviderCommandLaunch({ command, args })
  const cliCwd = await resolveWhitenoiseCliCwd()

  return runWhitenoiseCliProcess({
    provider,
    launch,
    cwd: cliCwd,
    env: runtime.env,
  })
}

export async function generateScene(prompt: string | null): Promise<NoiseScene> {
  const userPrompt = prompt?.trim() || ''

  // Try Claude first, then Codex — same order as chat cards
  for (const provider of ['claude', 'codex'] as const) {
    try {
      const raw = await callViaCli(provider, userPrompt)
      const { title, layers } = parseSceneResponse(raw)

      return {
        id: createId(),
        title,
        prompt: userPrompt || title,
        layers,
        createdAt: new Date().toISOString(),
      }
    } catch (error) {
      console.warn(`[whitenoise] ${provider} CLI generation failed:`, error)
      continue
    }
  }

  throw new Error('No local CLI available. Install claude or codex CLI to generate scenes.')
}
