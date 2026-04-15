import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const sharedEnv = {
  ...process.env,
}

delete sharedEnv.ELECTRON_RUN_AS_NODE

const electronProcess = spawn(electronBinary, ['.'], {
  cwd: projectRoot,
  env: sharedEnv,
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
})

electronProcess.on('error', (error) => {
  console.error('[electron:start]', error)
  process.exit(1)
})

electronProcess.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 0)
})
