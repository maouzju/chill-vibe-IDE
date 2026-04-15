import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { getAppDataDir } from './app-paths.js'

const logsDir = () => path.join(getAppDataDir(), 'logs')
const logFile = () => path.join(logsDir(), 'server.log')

let dirReady = false

async function ensureDir() {
  if (dirReady) return
  await mkdir(logsDir(), { recursive: true })
  dirReady = true
}

function formatEntry(level: string, message: string, extra?: unknown) {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${level}] ${message}`
  return extra ? `${base} ${JSON.stringify(extra)}\n` : `${base}\n`
}

export async function writeServerLog(level: string, message: string, extra?: unknown) {
  try {
    await ensureDir()
    await appendFile(logFile(), formatEntry(level, message, extra))
  } catch {
    // Best-effort — don't crash the server because of logging.
  }
}

export function initServerCrashLogger() {
  process.on('uncaughtException', (error) => {
    console.error('[server] uncaughtException:', error)
    void writeServerLog('ERROR', `uncaughtException: ${error.message}`, { stack: error.stack })
  })

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason)
    const stack = reason instanceof Error ? reason.stack : undefined
    console.error('[server] unhandledRejection:', reason)
    void writeServerLog('ERROR', `unhandledRejection: ${message}`, { stack })
  })

  void writeServerLog('INFO', 'Server crash logger initialized')
}
