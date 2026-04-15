import childProcess from 'node:child_process'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const viteCliPath = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')

const originalExec = childProcess.exec
childProcess.exec = function patchedExec(command, options, callback) {
  const normalized = typeof command === 'string' ? command.trim().toLowerCase() : ''

  if (normalized === 'net use') {
    const cb = typeof options === 'function' ? options : callback
    queueMicrotask(() => {
      if (typeof cb === 'function') {
        cb(null, '', '')
      }
    })

    return {
      pid: 0,
      kill() {},
      on() {
        return this
      },
      once() {
        return this
      },
      stdout: null,
      stderr: null,
    }
  }

  return originalExec.call(this, command, options, callback)
}

syncBuiltinESMExports()
process.argv = [process.argv[0], viteCliPath, ...process.argv.slice(2)]

await import(pathToFileURL(viteCliPath).href)
