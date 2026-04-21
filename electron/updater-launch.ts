import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

type SpawnOptions = {
  detached: boolean
  stdio: ['ignore', number, number]
  windowsHide: boolean
}

type PowerShellChildProcess = {
  once(event: 'error', listener: (error: Error) => void): PowerShellChildProcess
  once(event: 'spawn', listener: () => void): PowerShellChildProcess
  unref(): void
}

export type PowerShellSpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => PowerShellChildProcess

export function resolveWindowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
) {
  const systemRoot = env.SystemRoot?.trim() || env.windir?.trim()

  if (systemRoot) {
    const absolutePath = path.win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )

    if (fileExists(absolutePath)) {
      return absolutePath
    }
  }

  return 'powershell.exe'
}

export async function launchDetachedPowerShellScriptFile({
  scriptPath,
  stdoutFd,
  stderrFd,
  env = process.env,
  fileExists = existsSync,
  spawnProcess = spawn,
}: {
  scriptPath: string
  stdoutFd: number
  stderrFd: number
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
  spawnProcess?: PowerShellSpawnProcess
}) {
  const command = resolveWindowsPowerShellPath(env, fileExists)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawnProcess(command, args, {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    })

    child.once('error', (error) => {
      if (settled) {
        return
      }

      settled = true
      reject(error)
    })

    child.once('spawn', () => {
      if (settled) {
        return
      }

      settled = true
      child.unref()
      resolve()
    })
  })
}
