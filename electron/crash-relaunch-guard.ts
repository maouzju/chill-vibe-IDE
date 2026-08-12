// Decision logic for the out-of-tree guard that brings the app back after it is
// killed without warning.
//
// Symptom: 2026-08-10 and 2026-08-11 logged 10 and 8 hard exits respectively --
// the window simply vanished, and the user had to notice and relaunch by hand.
// Root cause (death, measured): a controlled experiment on 2026-08-12 killed an
// isolated instance with `taskkill /PID <pid> /T /F` and captured exit code 1
// with none of the shutdown log lines, no minidump and no Windows event; the
// clean-shutdown control produced exit code 0 with before-quit and will-quit
// both present. The real flash-exits match the kill signature exactly, so the
// app is being terminated from outside rather than crashing.
// Why the app cannot defend itself: nothing in user space can refuse
// TerminateProcess, so surviving is impossible and coming back is the only
// option left.
//
// Why a pipe rather than a PID poll: the guard has to notice a death, and
// polling "is PID N alive" is precisely the mistake under investigation -- a
// recycled PID reads as alive and the guard would wait forever. A named pipe
// closes the instant the process holding it dies, no matter how it dies, and no
// number can be reused into it.
//
// Why it is spawned through `cmd /c start`: taskkill /T walks the target's
// children, so a guard whose parent is the app dies with the app. Launching it
// through an intermediate that exits immediately leaves the guard parented to a
// dead PID, outside any tree that names the app.

import path from 'node:path'

import { parseRunSentinel, shouldRelaunch } from './crash-relaunch-policy.js'

export type GuardArgs = {
  pipe: string
  sentinelPath: string
  historyPath: string
  execPath: string
}

export type GuardAction = 'relaunch' | 'stand-down' | 'throttled'

const relaunchWindowMs = 10 * 60 * 1000

export const guardPipePath = (pid: number): string => `\\\\.\\pipe\\chill-vibe-relaunch-${pid}`

export const guardSentinelPath = (dataDir: string): string =>
  path.join(dataDir, 'run-sentinel.json')

export const guardHistoryPath = (dataDir: string): string =>
  path.join(dataDir, 'relaunch-history.json')

export const pruneRelaunchHistory = (
  history: readonly number[],
  nowMs: number,
): number[] => history.filter((at) => Number.isFinite(at) && nowMs - at < relaunchWindowMs)

// The sentinel is passed as raw text because the guard reads it off disk at the
// moment the pipe closes, and a partial write must not throw inside the guard.
export const decideGuardAction = (
  sentinelText: string | null,
  relaunchHistoryMs: readonly number[],
  nowMs: number,
): GuardAction => {
  if (!sentinelText) {
    return 'stand-down'
  }

  const sentinel = parseRunSentinel(sentinelText)
  if (!sentinel) {
    return 'stand-down'
  }

  // The pipe closes on every exit, clean or not. Only the sentinel distinguishes
  // "the user closed the window" from "something terminated us".
  if (sentinel.cleanExit) {
    return 'stand-down'
  }

  return shouldRelaunch(relaunchHistoryMs, nowMs, { windowMs: relaunchWindowMs })
    ? 'relaunch'
    : 'throttled'
}

// 症状：2026-08-12 02:07 实测，守护报告 `relaunched` 但复活的实例一行日志都没写，
//       隔离数据目录的启动计数停在 1 —— 自恢复看起来成功，实际什么都没恢复。
// 根因：打包后没有独立的 node，守护只能用主二进制 + ELECTRON_RUN_AS_NODE=1 当运行时
//       （见 electron/main.ts 生成的 relaunch-guard.cmd）。spawn 新实例时该变量被原样
//       继承，新进程于是以 Node 模式启动：不初始化 Electron、不建窗口，随即退出。
// 为什么不能换写法：守护自身必须保留这个变量才能跑，所以只能在交给子进程的那份环境副本
//       里删掉它；置成空字符串无效，Electron 只判断变量是否存在。
export const buildRelaunchEnv = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> => {
  const next = { ...source }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}

export const parseGuardArgs = (argv: readonly string[]): GuardArgs | null => {
  const read = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    if (index < 0 || index + 1 >= argv.length) {
      return null
    }
    const value = argv[index + 1]
    return value && !value.startsWith('--') ? value : null
  }

  const pipe = read('--pipe')
  const sentinelPath = read('--sentinel')
  const historyPath = read('--history')
  const execPath = read('--exec')

  if (!pipe || !sentinelPath || !historyPath || !execPath) {
    return null
  }

  return { pipe, sentinelPath, historyPath, execPath }
}
