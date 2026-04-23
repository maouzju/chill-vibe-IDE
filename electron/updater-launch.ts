import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

type SpawnOptions = {
  detached: boolean
  stdio: 'ignore'
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
  env = process.env,
  fileExists = existsSync,
  spawnProcess = spawn,
}: {
  scriptPath: string
  env?: NodeJS.ProcessEnv
  fileExists?: (path: string) => boolean
  spawnProcess?: PowerShellSpawnProcess
}) {
  // Why cmd.exe wrapping:
  // Node's `spawn('powershell.exe', args, { detached: true, stdio: 'ignore',
  // windowsHide: true })` causes PowerShell to exit 0 immediately without
  // executing the script on Windows — likely because CREATE_NO_WINDOW +
  // DETACHED_PROCESS leaves PS without a console it can attach to. Wrapping
  // through `cmd.exe /c start "" /B` gives PS a proper detached environment
  // without a visible window and lets it actually run the script to completion
  // even after the parent Electron process exits.
  const psPath = resolveWindowsPowerShellPath(env, fileExists)
  const command = 'cmd.exe'
  const args = [
    '/c',
    'start',
    '""',
    '/B',
    psPath,
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ]

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawnProcess(command, args, {
      detached: true,
      stdio: 'ignore',
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
