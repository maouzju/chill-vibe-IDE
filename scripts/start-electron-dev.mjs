import net from 'node:net'
import { spawn, execSync } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolveSpawnLaunch } from './spawn-launch.mjs'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const devMarkerArg = '--chill-vibe-dev'
const sharedEnv = {
  ...process.env,
  VITE_DEV_SERVER_URL: 'http://localhost:5173',
}
const loopbackHosts = ['127.0.0.1', '::1']

delete sharedEnv.ELECTRON_RUN_AS_NODE

function spawnCommand(command, args, options = {}) {
  const hasExplicitShell = Object.prototype.hasOwnProperty.call(options, 'shell')
  const launch =
    process.platform === 'win32' && !hasExplicitShell
      ? resolveSpawnLaunch({
          command,
          args,
          platform: process.platform,
          comspec: sharedEnv.ComSpec,
        })
      : { command, args }

  return spawn(launch.command, launch.args, {
    cwd: projectRoot,
    env: sharedEnv,
    shell: false,
    stdio: 'inherit',
    ...options,
  })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, options)

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function isPortReady(port) {
  return Promise.all(
    loopbackHosts.map(
      (host) =>
        new Promise((resolve) => {
          const socket = net.connect({ host, port })

          socket.once('connect', () => {
            socket.end()
            resolve(true)
          })

          socket.once('error', () => {
            resolve(false)
          })
        }),
    ),
  ).then((results) => results.some(Boolean))
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await isPortReady(port)) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Port ${port} did not become ready within ${timeoutMs}ms`)
}

async function ensureDevServices() {
  const clientReady = await isPortReady(5173)

  if (clientReady) {
    console.log('[electron:dev] Reusing existing renderer dev server on 5173')
    return
  }

  console.log('[electron:dev] Restarting renderer dev server')

  if (process.platform === 'win32') {
    await runCommand('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'restart-dev.ps1')], {
      shell: false,
    })
  } else {
    const devProcess = spawnCommand('pnpm', ['dev:client'])
    const stopDevProcess = () => {
      if (!devProcess.killed) {
        devProcess.kill()
      }
    }

    process.once('SIGINT', stopDevProcess)
    process.once('SIGTERM', stopDevProcess)
  }

  await waitForPort(5173)
}

function killStaleDevInstances() {
  if (process.platform !== 'win32') {
    try {
      const out = execSync(`pgrep -af "${devMarkerArg}"`, { encoding: 'utf8', timeout: 3000 })

      for (const line of out.trim().split('\n')) {
        const pid = parseInt(line, 10)

        if (pid && pid !== process.pid) {
          try {
            process.kill(pid, 'SIGTERM')
            console.log(`[electron:dev] Killed stale dev instance (PID ${pid})`)
          } catch {}
        }
      }
    } catch {}
    return
  }

  try {
    const out = execSync(
      'wmic process where "name=\'electron.exe\'" get ProcessId,CommandLine /format:csv',
      { encoding: 'utf8', timeout: 5000 },
    )

    for (const line of out.split('\n')) {
      if (!line.includes(devMarkerArg)) {
        continue
      }

      const parts = line.trim().split(',')
      const pid = parseInt(parts[parts.length - 1], 10)

      if (!pid || pid === process.pid) {
        continue
      }

      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 })
        console.log(`[electron:dev] Killed stale dev instance (PID ${pid})`)
      } catch {}
    }
  } catch {}
}

async function main() {
  killStaleDevInstances()
  await runCommand('pnpm', ['electron:compile'])
  await ensureDevServices()

  console.log('[electron:dev] Starting Electron')

  const electronProcess = spawn(electronBinary, ['.', '--', devMarkerArg], {
    cwd: projectRoot,
    env: sharedEnv,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  })

  electronProcess.on('error', (error) => {
    console.error('[electron:dev]', error)
    process.exit(1)
  })

  electronProcess.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }

    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error('[electron:dev]', error)
  process.exit(1)
})
