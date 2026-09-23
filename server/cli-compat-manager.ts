import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  compatibleCliVersions,
  type CliCompatEntry,
  type CliCompatStatus,
} from '../shared/cli-compat.js'
import type { Provider } from '../shared/schema.js'
import { getAppDataDir } from './app-paths.js'
import { writeServerLog } from './crash-logger.js'
import { decodeConsoleOutput } from './file-encoding.js'
import { resolveProviderCommandLaunch } from './provider-command-launch.js'

// 兼容包 = 用 npm --prefix 把「本 IDE 版本验证过的 CLI 版本」装进数据目录，互不干扰系统全局 CLI。
// 「切换使用」只是往 active.json 记一个版本号，resolveCommand 优先读它；
// 为什么不写进 state.json 的 settings：旧包会用旧 schema 重写 state.json 把新字段剥掉
// （见 memory stale-packaged-build-strips-new-settings），独立文件不受影响。
const providers: Provider[] = ['claude', 'codex']

export const getCliCompatRoot = () => path.join(getAppDataDir(), 'cli-compat')

const getActiveFilePath = (root: string) => path.join(root, 'active.json')

export const getCompatInstallPrefix = (provider: Provider, version: string, root = getCliCompatRoot()) =>
  path.join(root, provider, version)

export const getCompatBinPath = (provider: Provider, version: string, root = getCliCompatRoot()) =>
  path.join(
    getCompatInstallPrefix(provider, version, root),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${provider}.cmd` : provider,
  )

export const readActiveCompatVersions = async (
  root = getCliCompatRoot(),
): Promise<Partial<Record<Provider, string>>> => {
  try {
    const parsed = JSON.parse(await readFile(getActiveFilePath(root), 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }

    const result: Partial<Record<Provider, string>> = {}
    for (const provider of providers) {
      const value = (parsed as Record<string, unknown>)[provider]
      if (typeof value === 'string' && value.trim()) {
        result[provider] = value.trim()
      }
    }
    return result
  } catch {
    return {}
  }
}

export const writeActiveCompatVersion = async (
  provider: Provider,
  version: string | null,
  root = getCliCompatRoot(),
) => {
  const current = await readActiveCompatVersions(root)
  if (version) {
    current[provider] = version
  } else {
    delete current[provider]
  }

  await mkdir(root, { recursive: true })
  const target = getActiveFilePath(root)
  const temp = `${target}.tmp`
  await writeFile(temp, JSON.stringify(current, null, 2), 'utf8')
  await rename(temp, target)
}

export const resolveCompatCommand = async (provider: Provider, root = getCliCompatRoot()) => {
  const version = (await readActiveCompatVersions(root))[provider]
  if (!version) {
    return null
  }

  const bin = getCompatBinPath(provider, version, root)
  return existsSync(bin) ? bin : null
}

const readCliVersion = async (command: string) => {
  const launch = await resolveProviderCommandLaunch({ command, args: ['--version'] })

  return new Promise<string | null>((resolve) => {
    const child = spawn(launch.command, launch.args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, 15_000)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const match = decodeConsoleOutput(chunks).match(/\d+\.\d+\.\d+[\w.-]*/)
      resolve(match?.[0] ?? null)
    })
  })
}

type Task = NonNullable<CliCompatEntry['task']>

export class CliCompatManager {
  private readonly tasks = new Map<Provider, Task>()
  private readonly systemVersionCache = new Map<string, Promise<string | null>>()

  constructor(
    private readonly resolveSystemCommand: (provider: Provider) => Promise<string | null | undefined>,
  ) {}

  private getSystemVersion(command: string) {
    let cached = this.systemVersionCache.get(command)
    if (!cached) {
      cached = readCliVersion(command)
      this.systemVersionCache.set(command, cached)
    }
    return cached
  }

  async getStatus(): Promise<CliCompatStatus> {
    const active = await readActiveCompatVersions()
    const entries = await Promise.all(
      providers.map(async (provider): Promise<CliCompatEntry> => {
        const compatibleVersion = compatibleCliVersions[provider].version
        const activeVersion = (await resolveCompatCommand(provider)) ? (active[provider] ?? null) : null
        const systemCommand = await this.resolveSystemCommand(provider).catch(() => null)

        return {
          provider,
          compatibleVersion,
          installed: existsSync(getCompatBinPath(provider, compatibleVersion)),
          active: activeVersion === compatibleVersion,
          activeVersion,
          systemVersion: systemCommand ? await this.getSystemVersion(systemCommand) : null,
          task: this.tasks.get(provider) ?? null,
        }
      }),
    )

    return { entries }
  }

  async setActive(provider: Provider, active: boolean) {
    const version = compatibleCliVersions[provider].version
    if (active && !existsSync(getCompatBinPath(provider, version))) {
      throw new Error(`Compatible ${provider} CLI ${version} is not installed.`)
    }

    await writeActiveCompatVersion(provider, active ? version : null)
    return this.getStatus()
  }

  // 下载完成后自动切换到兼容版，这就是「一个按钮」的全部语义。
  async install(provider: Provider) {
    if (this.tasks.get(provider)?.status !== 'running') {
      const { version, npmPackage } = compatibleCliVersions[provider]
      this.tasks.set(provider, { status: 'running', message: `${npmPackage}@${version}` })
      void this.runInstall(provider, version, npmPackage)
    }

    return this.getStatus()
  }

  private async runInstall(provider: Provider, version: string, npmPackage: string) {
    const prefix = getCompatInstallPrefix(provider, version)
    const tail: string[] = []

    try {
      await mkdir(prefix, { recursive: true })
      const exitCode = await new Promise<number | null>((resolve) => {
        // npm 在 Windows 上是 npm.cmd，只能走 shell；参数全是本文件里的常量，没有注入面。
        const child = spawn(
          `npm install --prefix "${prefix}" --no-save --no-audit --no-fund ${npmPackage}@${version}`,
          { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        const collect = (chunk: Buffer) => {
          tail.push(...decodeConsoleOutput([chunk]).split(/\r?\n/).filter(Boolean))
          tail.splice(0, Math.max(0, tail.length - 20))
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        child.on('error', () => resolve(null))
        child.on('close', resolve)
      })

      const bin = getCompatBinPath(provider, version)
      const installedVersion = existsSync(bin) ? await readCliVersion(bin) : null
      if (exitCode !== 0 || installedVersion !== version) {
        throw new Error(
          `npm exit ${exitCode}, installed version ${installedVersion ?? 'none'}\n${tail.slice(-8).join('\n')}`,
        )
      }

      await writeActiveCompatVersion(provider, version)
      this.tasks.set(provider, { status: 'succeeded', message: version })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void writeServerLog('WARN', '[cli-compat] install failed.', { provider, version, message })
      this.tasks.set(provider, { status: 'failed', message })
    }
  }
}
