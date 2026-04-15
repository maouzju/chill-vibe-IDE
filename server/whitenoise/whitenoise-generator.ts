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

  const args =
    provider === 'claude'
      ? [
          ...runtime.args,
          '-p',
          '--output-format', 'text',
          '--max-turns', '1',
          prompt,
        ]
      : [
          ...runtime.args,
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          '-q',
          prompt,
        ]

  const launch = await resolveProviderCommandLaunch({ command, args })
  const cliCwd = await resolveWhitenoiseCliCwd()

  return new Promise<string>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd: cliCwd,
      env: runtime.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${provider} CLI exited with code ${code}: ${stderr.slice(0, 200)}`))
        return
      }

      if (provider === 'codex') {
        // Codex --json outputs newline-delimited JSON events; extract the last assistant message
        const lines = stdout.trim().split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const event = JSON.parse(lines[i])
            if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
              resolve(event.content)
              return
            }
            // Also handle response.completed format
            if (event.type === 'response.completed' && event.response?.output) {
              for (const item of event.response.output) {
                if (item.type === 'message' && typeof item.content === 'string') {
                  resolve(item.content)
                  return
                }
                if (Array.isArray(item.content)) {
                  const text = item.content
                    .filter((c: { type?: string; text?: string }) => c.type === 'output_text' || c.type === 'text')
                    .map((c: { text?: string }) => c.text ?? '')
                    .join('')
                  if (text) {
                    resolve(text)
                    return
                  }
                }
              }
            }
          } catch {
            // not JSON, skip
          }
        }
        // Fallback: return raw stdout
        resolve(stdout.trim())
      } else {
        // Claude --output-format text returns plain text
        resolve(stdout.trim())
      }
    })

    child.on('error', (error) => {
      reject(new Error(`Failed to spawn ${provider} CLI: ${error.message}`))
    })
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
