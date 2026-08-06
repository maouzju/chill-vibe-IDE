import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const originalReadFile = fs.promises.readFile
const originalReaddir = fs.promises.readdir

const isSessionHistoryPath = (value) =>
  typeof value === 'string' && value.split(/[\\/]/).includes('session-history')

const report = (operation, value) => {
  if (isSessionHistoryPath(value)) {
    process.send?.({
      type: 'session-history-fs-access',
      operation,
      path: String(value),
    })
  }
}

fs.promises.readFile = async (...args) => {
  report('readFile', args[0])
  return originalReadFile(...args)
}

fs.promises.readdir = async (...args) => {
  report('readdir', args[0])
  return originalReaddir(...args)
}

syncBuiltinESMExports()
process.send?.({ type: 'session-history-spy-ready' })
