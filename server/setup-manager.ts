import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath, URL } from 'node:url'

import type { SetupLog, SetupRunRequest, SetupStatus } from '../shared/schema.js'

const maxLogs = 400
const setupScriptRelativePath = path.join('scripts', 'setup-ai-cli.ps1')

const now = () => new Date().toISOString()

const createLog = (message: string, level: SetupLog['level'] = 'info'): SetupLog => ({
  createdAt: now(),
  level,
  message,
})

type ResolveSetupScriptPathOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  moduleUrl?: string
  resourcesPath?: string
  exists?: (path: string) => boolean
}

const getElectronResourcesPath = () =>
  (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath

const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/
const uncPathPattern = /^\\\\/

const isWindowsLikePath = (value: string) =>
  windowsAbsolutePathPattern.test(value) || uncPathPattern.test(value)

const resolvePortablePath = (value: string) =>
  isWindowsLikePath(value) ? path.win32.normalize(value) : path.resolve(value)

const resolvePortablePathFrom = (basePath: string, relativePath: string) =>
  isWindowsLikePath(basePath)
    ? path.win32.resolve(basePath, relativePath)
    : path.resolve(basePath, relativePath)

const getPortableDirname = (value: string) =>
  isWindowsLikePath(value) ? path.win32.dirname(value) : path.dirname(value)

const fileUrlToPortablePath = (moduleUrl: string) => {
  const url = new URL(moduleUrl)
  const decodedPathname = decodeURIComponent(url.pathname)

  if (/^\/[A-Za-z]:[\\/]/.test(decodedPathname)) {
    return path.win32.normalize(decodedPathname.slice(1))
  }

  return fileURLToPath(url)
}

export const resolveSetupScriptPath = ({
  cwd = process.cwd(),
  env = process.env,
  moduleUrl = import.meta.url,
  resourcesPath = getElectronResourcesPath(),
  exists = existsSync,
}: ResolveSetupScriptPathOptions = {}) => {
  const overridePath = env.CHILL_VIBE_SETUP_SCRIPT_PATH?.trim()
  const moduleDirectory = getPortableDirname(fileUrlToPortablePath(moduleUrl))
  const candidates = [
    overridePath ? resolvePortablePath(overridePath) : null,
    resourcesPath ? resolvePortablePathFrom(resourcesPath, setupScriptRelativePath) : null,
    resolvePortablePathFrom(moduleDirectory, path.join('..', setupScriptRelativePath)),
    resolvePortablePathFrom(cwd, setupScriptRelativePath),
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => exists(candidate))
}

const normalizeSetupRunRequest = (request: SetupRunRequest = {
  mode: 'install-missing',
  cli: 'all',
  version: 'latest',
}): SetupRunRequest => ({
  mode: request.mode,
  cli: request.cli,
  version: request.version.trim() || 'latest',
})

export const buildSetupScriptArguments = (
  scriptPath: string,
  request?: SetupRunRequest,
) => {
  const normalized = normalizeSetupRunRequest(request)

  return [
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Mode',
    normalized.mode,
    '-Cli',
    normalized.cli,
    '-Version',
    normalized.version,
  ]
}

export class SetupManager {
  private child: ChildProcess | null = null

  private status: SetupStatus = {
    state: 'idle',
    logs: [],
  }

  getStatus(): SetupStatus {
    return {
      ...this.status,
      logs: [...this.status.logs],
    }
  }

  start(request?: SetupRunRequest): SetupStatus {
    if (this.status.state === 'running') {
      return this.getStatus()
    }

    if (process.platform !== 'win32') {
      this.status = {
        state: 'unsupported',
        message: 'One-click environment setup is currently available on Windows only.',
        finishedAt: now(),
        logs: [createLog('One-click environment setup is currently available on Windows only.', 'error')],
      }
      return this.getStatus()
    }

    const scriptPath = resolveSetupScriptPath()
    if (!scriptPath || !existsSync(scriptPath)) {
      this.status = {
        state: 'error',
        message: `Setup script not found: ${scriptPath ?? setupScriptRelativePath}`,
        finishedAt: now(),
        logs: [createLog(`Setup script not found: ${scriptPath ?? setupScriptRelativePath}`, 'error')],
      }
      return this.getStatus()
    }

    this.status = {
      state: 'running',
      startedAt: now(),
      logs: [createLog('Starting one-click environment setup...')],
    }

    const child = spawn(
      'powershell.exe',
      buildSetupScriptArguments(scriptPath, request),
      {
        cwd: path.dirname(scriptPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.child = child

    const stdout = readline.createInterface({ input: child.stdout! })
    const stderr = readline.createInterface({ input: child.stderr! })

    stdout.on('line', (line) => {
      this.appendLog(line)
    })

    stderr.on('line', (line) => {
      this.appendLog(line, 'error')
    })

    child.on('error', (error) => {
      this.child = null
      stdout.close()
      stderr.close()
      this.status = {
        ...this.status,
        state: 'error',
        message: error.message,
        finishedAt: now(),
      }
      this.appendLog(error.message, 'error')
    })

    child.on('close', (code) => {
      this.child = null
      stdout.close()
      stderr.close()

      const succeeded = code === 0
      this.status = {
        ...this.status,
        state: succeeded ? 'success' : 'error',
        message: succeeded
          ? 'Environment setup completed.'
          : `Environment setup failed with exit code ${code ?? 'unknown'}.`,
        finishedAt: now(),
      }
      this.appendLog(this.status.message ?? '', succeeded ? 'info' : 'error')
    })

    return this.getStatus()
  }

  dispose() {
    this.child?.kill()
    this.child = null
  }

  private appendLog(message: string, level: SetupLog['level'] = 'info') {
    const trimmed = message.trim()
    if (!trimmed) {
      return
    }

    const logs = [...this.status.logs, createLog(trimmed, level)]
    this.status = {
      ...this.status,
      logs: logs.slice(-maxLogs),
    }
  }
}
