import path from 'node:path'
import log from 'electron-log/main.js'
import { app, ipcMain } from 'electron'

export { log }

export function initCrashLogger() {
  const dataDir = process.env.CHILL_VIBE_DATA_DIR ?? path.join(process.cwd(), '.chill-vibe')
  const logsDir = path.join(dataDir, 'logs')

  log.transports.file.resolvePathFn = () => path.join(logsDir, 'main.log')
  log.transports.file.maxSize = 5 * 1024 * 1024 // 5 MB
  log.transports.console.level = app.isPackaged ? false : 'warn'

  log.initialize()

  process.on('uncaughtException', (error) => {
    log.error('[main] uncaughtException:', error)
  })

  process.on('unhandledRejection', (reason) => {
    log.error('[main] unhandledRejection:', reason)
  })

  process.on('exit', (code) => {
    log.warn('[main] process exit.', { code })
  })

  ipcMain.handle('crash-log:write', (_event, level: string, message: string, meta?: unknown) => {
    const fn = level === 'warn' ? log.warn : log.error
    fn('[renderer]', message, ...(meta !== undefined ? [meta] : []))
  })

  log.info('[main] Crash logger initialized')
}
