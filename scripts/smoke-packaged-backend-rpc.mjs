#!/usr/bin/env node

// Packaged-backend smoke helper.  This deliberately crosses the same boundary
// as the real renderer: Chromium CDP -> preload electronAPI -> main IPC ->
// utilityProcess RPC -> server/state-store.  Merely finding utility-host.js or
// a NodeService child is not enough to prove that this request path works.

import process from 'node:process'

import { chromium } from '@playwright/test'

const DEFAULT_TIMEOUT_MS = 90_000

function parseArgs(argv) {
  const options = { port: null, timeoutMs: DEFAULT_TIMEOUT_MS }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--port') {
      options.port = Number.parseInt(argv[index + 1] ?? '', 10)
      index += 1
      continue
    }
    if (arg.startsWith('--port=')) {
      options.port = Number.parseInt(arg.slice('--port='.length), 10)
      continue
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = Number.parseInt(argv[index + 1] ?? '', 10)
      index += 1
      continue
    }
    if (arg.startsWith('--timeout-ms=')) {
      options.timeoutMs = Number.parseInt(arg.slice('--timeout-ms='.length), 10)
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.help) {
    return options
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('A valid --port is required.')
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error('--timeout-ms must be a positive number.')
  }
  return options
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// connectOverCDP 不把远端 Electron 进程交给 Playwright 管理；直接调用
// browser.close() 会向 Chromium 发送 Browser.close，并等待远端退出。冒烟只
// 需要断开自己的 WebSocket，否则 helper 在已经打印“通过”后仍会挂住，外层
// PowerShell 会把它误判成超时。私有连接对象的 close 是同步断开，不会关掉目标 app。
const disconnectFromCdp = (browser) => {
  const connection = browser?._connection
  if (connection && typeof connection.close === 'function') {
    connection.close()
    return
  }

  // 兼容未来 Playwright 改变内部形状：退回公开 API，失败也不能遮住已拿到的
  // RPC 结果；外层脚本仍会按 pid 清理它启动的 app。
  void browser?.close?.().catch?.(() => undefined)
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`CDP endpoint returned HTTP ${response.status}.`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function waitForRendererApi(browser, deadline) {
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap((context) => context.pages())
    for (const page of pages) {
      try {
        const hasApi = await page.evaluate(() => {
          const api = globalThis.window?.electronAPI
          return Boolean(api && typeof api.fetchState === 'function')
        })
        if (!hasApi) {
          continue
        }

        const response = await page.evaluate(async () => {
          const value = await globalThis.window.electronAPI.fetchState()
          if (!value || typeof value !== 'object') {
            return value
          }

          // Never send the persisted state to stdout: it may contain workspace
          // paths, prompts, or provider metadata.  Return only the shape needed
          // to prove the request completed through the backend RPC.
          const state = value.state
          return {
            hasState: Boolean(state && typeof state === 'object'),
            columnCount: Array.isArray(state?.columns) ? state.columns.length : -1,
            hasSettings: Boolean(state?.settings && typeof state.settings === 'object'),
          }
        })

        if (
          response &&
          response.hasState === true &&
          response.hasSettings === true &&
          Number.isInteger(response.columnCount) &&
          response.columnCount >= 0
        ) {
          return response
        }
      } catch {
        // The page can be replaced while the packaged renderer retries its
        // initial load.  Keep polling until the deadline instead of turning a
        // transient execution-context loss into a false negative.
      }
    }
    await sleep(250)
  }

  throw new Error('Timed out waiting for renderer electronAPI.fetchState() to succeed.')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/smoke-packaged-backend-rpc.mjs --port <port> [--timeout-ms <ms>]\n',
    )
    return
  }

  const endpoint = `http://127.0.0.1:${options.port}`
  const deadline = Date.now() + options.timeoutMs
  let browser = null
  let lastError = null

  try {
    while (Date.now() < deadline) {
      try {
        // /json/version becomes available only after Chromium has initialized;
        // connecting through this endpoint avoids launching a second browser.
        await fetchJson(`${endpoint}/json/version`, 2_000)
        browser = await chromium.connectOverCDP(endpoint)
        const result = await waitForRendererApi(browser, deadline)
        process.stdout.write(
          `CHILL_VIBE_PACKAGED_RPC_OK columns=${result.columnCount}\n真实 RPC 通过：electronAPI.fetchState() 返回有效状态（columns=${result.columnCount}）\n`,
        )
        return
      } catch (error) {
        lastError = error
        if (browser) {
          disconnectFromCdp(browser)
          browser = null
        }
        await sleep(250)
      }
    }
  } finally {
    // connectOverCDP attaches to the packaged app; it does not own the app
    // process, but the Playwright connection itself keeps this helper alive.
    disconnectFromCdp(browser)
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Timed out waiting for packaged renderer CDP/RPC.')
}

try {
  await main()
  // Playwright's CDP transport can leave a socket/heartbeat handle around even
  // after browser.close().  This helper is a one-shot probe, so terminate its
  // own process explicitly once the probe has completed; the attached Electron
  // process is not owned by this exit.
  process.exit(0)
} catch (error) {
  process.stderr.write(
    `真实 RPC 冒烟失败：${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
}
