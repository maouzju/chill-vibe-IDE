import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import readline from 'node:readline'

import type {
  OllamaJudgeRequest,
  OllamaJudgeResponse,
  OllamaStatus,
  OllamaTask,
} from '../shared/schema.js'

const maxLogs = 200
const defaultOllamaBaseUrl = 'http://127.0.0.1:11434'
const statusProbeTimeoutMs = 2_000
const judgeTimeoutMs = 60_000

const now = () => new Date().toISOString()

const createLog = (message: string, level: 'info' | 'error' = 'info') => ({
  createdAt: now(),
  level,
  message,
})

export const resolveOllamaBaseUrl = (env: NodeJS.ProcessEnv = process.env) => {
  const override = env.CHILL_VIBE_OLLAMA_URL?.trim()
  return (override || defaultOllamaBaseUrl).replace(/\/+$/g, '')
}

const gb = 1024 ** 3

// The urge verdict is a light classification task, so small local models are
// enough; scale the recommendation with how much RAM the machine can spare.
export const recommendOllamaModel = (totalMemBytes: number) => {
  const totalMemoryGb = Math.round(totalMemBytes / gb)

  if (totalMemBytes >= 30 * gb) {
    return { name: 'qwen3:8b', totalMemoryGb }
  }

  if (totalMemBytes >= 14 * gb) {
    return { name: 'qwen3:4b', totalMemoryGb }
  }

  return { name: 'qwen3:1.7b', totalMemoryGb }
}

const judgeTextTailLimit = 6000

export const buildUrgeJudgePrompt = (text: string) => {
  const tail = text.length > judgeTextTailLimit ? text.slice(-judgeTextTailLimit) : text

  return [
    '你是一个严格的任务验收判定器。下面是一个 AI agent 在一轮工作结束时输出的最后一段话。',
    '请判断这个 agent 是否需要被催促继续工作：',
    '- 如果它明确表示任务已完成、验证已通过、或在等待用户输入而无事可做，输出 {"shouldContinue": false}',
    '- 如果它在向用户提问、请求确认、或等待用户做决定（例如"要不要提交""你要的话说一声""需要我继续吗"），即使它同时提到还有可做的后续事项，这条规则优先，输出 {"shouldContinue": false}',
    '- 如果它还没有完成任务、只给出计划或中途汇报、或承认还有未验证/未解决的部分，输出 {"shouldContinue": true}',
    '只输出 JSON，不要输出其他内容。',
    '',
    'agent 的最后一段话：',
    '---',
    tail,
    '---',
  ].join('\n')
}

export const parseUrgeJudgeVerdict = (content: string): boolean | null => {
  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }

  const candidates: string[] = [trimmed]
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch?.[1]) {
    candidates.unshift(fenceMatch[1].trim())
  }
  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0]) {
    candidates.push(objectMatch[0])
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { shouldContinue?: unknown }).shouldContinue === 'boolean'
      ) {
        return (parsed as { shouldContinue: boolean }).shouldContinue
      }
    } catch {
      // try the next candidate shape
    }
  }

  return null
}

const urgeJudgeFormat = {
  type: 'object',
  properties: {
    shouldContinue: { type: 'boolean' },
  },
  required: ['shouldContinue'],
} as const

type OllamaManagerOptions = {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  totalMemBytes?: number
  isWindows?: boolean
}

export class OllamaManager {
  private child: ChildProcess | null = null

  private task: OllamaTask = { state: 'idle', logs: [] }

  private readonly env: NodeJS.ProcessEnv

  private readonly fetchImpl: typeof fetch

  private readonly totalMemBytes: number

  private readonly isWindows: boolean

  constructor(options: OllamaManagerOptions = {}) {
    this.env = options.env ?? process.env
    this.fetchImpl = options.fetchImpl ?? fetch
    this.totalMemBytes = options.totalMemBytes ?? os.totalmem()
    this.isWindows = options.isWindows ?? process.platform === 'win32'
  }

  private get baseUrl() {
    return resolveOllamaBaseUrl(this.env)
  }

  private async probeJson(path: string): Promise<unknown | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(statusProbeTimeoutMs),
      })
      if (!response.ok) {
        return null
      }
      return (await response.json()) as unknown
    } catch {
      return null
    }
  }

  private detectInstalled(): boolean {
    if (!this.isWindows) {
      const probe = spawnSync('which', ['ollama'], { windowsHide: true })
      return probe.status === 0
    }

    const probe = spawnSync('where.exe', ['ollama'], { windowsHide: true })
    return probe.status === 0
  }

  async getStatus(): Promise<OllamaStatus> {
    const version = (await this.probeJson('/api/version')) as { version?: string } | null
    const running = version !== null
    const tags = running
      ? ((await this.probeJson('/api/tags')) as {
          models?: Array<{ name?: string; size?: number }>
        } | null)
      : null
    const models = (tags?.models ?? [])
      .filter((entry): entry is { name: string; size?: number } => typeof entry?.name === 'string')
      .map((entry) => ({ name: entry.name, sizeBytes: entry.size }))

    return {
      installed: running || this.detectInstalled(),
      running,
      version: version?.version ?? '',
      models,
      recommendedModel: recommendOllamaModel(this.totalMemBytes),
      task: { ...this.task, logs: [...this.task.logs] },
    }
  }

  startInstall(): OllamaTask {
    if (this.task.state === 'running') {
      return this.getTaskSnapshot()
    }

    if (!this.isWindows) {
      this.task = {
        state: 'error',
        kind: 'install-ollama',
        logs: [createLog('One-click Ollama install is currently available on Windows only.', 'error')],
      }
      return this.getTaskSnapshot()
    }

    if (this.detectInstalled()) {
      // Installed but the local service is not answering — start it instead.
      this.task = {
        state: 'running',
        kind: 'start-service',
        logs: [createLog('Ollama is installed; starting the local service...')],
      }

      try {
        const child = spawn('ollama', ['serve'], {
          windowsHide: true,
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
        this.task = {
          ...this.task,
          state: 'success',
          logs: [...this.task.logs, createLog('Ollama service launch requested.')],
        }
      } catch (error) {
        this.task = {
          ...this.task,
          state: 'error',
          logs: [
            ...this.task.logs,
            createLog(error instanceof Error ? error.message : String(error), 'error'),
          ],
        }
      }
      return this.getTaskSnapshot()
    }

    this.task = {
      state: 'running',
      kind: 'install-ollama',
      logs: [createLog('Installing Ollama via winget...')],
    }
    this.runTaskProcess('winget', [
      'install',
      '--id',
      'Ollama.Ollama',
      '-e',
      '--silent',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ])
    return this.getTaskSnapshot()
  }

  startPull(model: string): OllamaTask {
    if (this.task.state === 'running') {
      return this.getTaskSnapshot()
    }

    this.task = {
      state: 'running',
      kind: 'pull-model',
      model,
      logs: [createLog(`Pulling model ${model}...`)],
    }
    this.runTaskProcess('ollama', ['pull', model])
    return this.getTaskSnapshot()
  }

  async judge(request: OllamaJudgeRequest): Promise<OllamaJudgeResponse> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          stream: false,
          format: urgeJudgeFormat,
          options: { temperature: 0 },
          messages: [{ role: 'user', content: buildUrgeJudgePrompt(request.text) }],
        }),
        signal: AbortSignal.timeout(judgeTimeoutMs),
      })

      if (!response.ok) {
        return { ok: false, error: `Ollama responded with HTTP ${response.status}` }
      }

      const payload = (await response.json()) as { message?: { content?: unknown } }
      const content = typeof payload.message?.content === 'string' ? payload.message.content : ''
      const verdict = parseUrgeJudgeVerdict(content)

      if (verdict === null) {
        return { ok: false, error: 'Ollama returned an unparseable urge verdict.' }
      }

      return { ok: true, shouldContinue: verdict }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  dispose() {
    this.child?.kill()
    this.child = null
  }

  private getTaskSnapshot(): OllamaTask {
    return { ...this.task, logs: [...this.task.logs] }
  }

  private runTaskProcess(command: string, args: string[]) {
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      })
    } catch (error) {
      this.task = {
        ...this.task,
        state: 'error',
        logs: [
          ...this.task.logs,
          createLog(error instanceof Error ? error.message : String(error), 'error'),
        ],
      }
      return
    }

    this.child = child

    const stdout = readline.createInterface({ input: child.stdout! })
    const stderr = readline.createInterface({ input: child.stderr! })
    stdout.on('line', (line) => this.appendLog(line))
    stderr.on('line', (line) => this.appendLog(line, 'error'))

    child.on('error', (error) => {
      this.child = null
      stdout.close()
      stderr.close()
      this.task = {
        ...this.task,
        state: 'error',
        logs: [...this.task.logs, createLog(error.message, 'error')].slice(-maxLogs),
      }
    })

    child.on('close', (code) => {
      this.child = null
      stdout.close()
      stderr.close()
      const succeeded = code === 0
      this.task = {
        ...this.task,
        state: succeeded ? 'success' : 'error',
        logs: [
          ...this.task.logs,
          createLog(
            succeeded ? 'Task completed.' : `Task failed with exit code ${code ?? 'unknown'}.`,
            succeeded ? 'info' : 'error',
          ),
        ].slice(-maxLogs),
      }
    })
  }

  private appendLog(message: string, level: 'info' | 'error' = 'info') {
    const trimmed = message.trim()
    if (!trimmed) {
      return
    }

    this.task = {
      ...this.task,
      logs: [...this.task.logs, createLog(trimmed, level)].slice(-maxLogs),
    }
  }
}
