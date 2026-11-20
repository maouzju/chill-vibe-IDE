import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildRelaunchGuardLauncher,
  decideGuardAction,
  guardPipePath,
  buildRelaunchEnv,
  parseGuardArgs,
  pruneRelaunchHistory,
} from '../electron/crash-relaunch-guard.ts'
import { serializeRunSentinel } from '../electron/crash-relaunch-policy.ts'

const now = Date.parse('2026-08-12T01:00:00.000Z')
const killedSentinel = serializeRunSentinel({
  pid: 5960,
  startedAtIso: '2026-08-11T22:45:14.000Z',
  cleanExit: false,
})
const cleanSentinel = serializeRunSentinel({
  pid: 5960,
  startedAtIso: '2026-08-11T22:45:14.000Z',
  cleanExit: true,
})

test('a pipe that closed while the sentinel is still dirty means a kill: relaunch', () => {
  assert.equal(decideGuardAction(killedSentinel, [], now), 'relaunch')
})

// The whole point of the sentinel: the guard's pipe closes on EVERY exit,
// including the user closing the window. Only the sentinel separates the two.
test('a clean shutdown stands the guard down instead of resurrecting the app', () => {
  assert.equal(decideGuardAction(cleanSentinel, [], now), 'stand-down')
})

test('a missing or corrupt sentinel stands down rather than guessing', () => {
  assert.equal(decideGuardAction(null, [], now), 'stand-down')
  assert.equal(decideGuardAction('not json', [], now), 'stand-down')
  assert.equal(decideGuardAction('', [], now), 'stand-down')
})

// Without this an app that is killed on sight would respawn forever, burning
// the PIDs whose exhaustion is implicated in the original bug.
test('a relaunch storm is throttled, not retried forever', () => {
  const history = [
    Date.parse('2026-08-12T00:58:00.000Z'),
    Date.parse('2026-08-12T00:59:00.000Z'),
    Date.parse('2026-08-12T00:59:30.000Z'),
  ]
  assert.equal(decideGuardAction(killedSentinel, history, now), 'throttled')
})

test('relaunches that aged out of the window do not throttle a fresh crash', () => {
  const history = [
    Date.parse('2026-08-12T00:00:00.000Z'),
    Date.parse('2026-08-12T00:10:00.000Z'),
    Date.parse('2026-08-12T00:20:00.000Z'),
  ]
  assert.equal(decideGuardAction(killedSentinel, history, now), 'relaunch')
})

test('history is pruned to the window so the file cannot grow without bound', () => {
  const history = [
    Date.parse('2026-08-12T00:00:00.000Z'),
    Date.parse('2026-08-12T00:59:00.000Z'),
  ]
  assert.deepEqual(pruneRelaunchHistory(history, now), [Date.parse('2026-08-12T00:59:00.000Z')])
})

test('pruning tolerates junk entries from a corrupted history file', () => {
  const history = [Number.NaN, Infinity, Date.parse('2026-08-12T00:59:00.000Z')] as number[]
  assert.deepEqual(pruneRelaunchHistory(history, now), [Date.parse('2026-08-12T00:59:00.000Z')])
})

// The guard is launched through `cmd /c start` to detach it, so it receives its
// configuration as argv rather than inheriting anything.
test('guard arguments round-trip through argv', () => {
  const parsed = parseGuardArgs([
    '--pipe',
    '\\\\.\\pipe\\chill-vibe-relaunch-5960',
    '--sentinel',
    'C:\\data\\run-sentinel.json',
    '--history',
    'C:\\data\\relaunch-history.json',
    '--exec',
    'C:\\app\\Chill Vibe.exe',
  ])
  assert.deepEqual(parsed, {
    pipe: '\\\\.\\pipe\\chill-vibe-relaunch-5960',
    sentinelPath: 'C:\\data\\run-sentinel.json',
    historyPath: 'C:\\data\\relaunch-history.json',
    execPath: 'C:\\app\\Chill Vibe.exe',
  })
})

test('incomplete guard arguments are rejected rather than half-run', () => {
  assert.equal(parseGuardArgs(['--pipe', 'x']), null)
  assert.equal(parseGuardArgs([]), null)
})

// A per-PID pipe name keeps a relaunched app from colliding with the pipe of the
// instance it is replacing, which may not have been reaped yet.
test('the pipe name is scoped per process', () => {
  assert.equal(guardPipePath(5960), '\\\\.\\pipe\\chill-vibe-relaunch-5960')
  assert.notEqual(guardPipePath(5960), guardPipePath(5961))
})

// 症状：2026-08-12 02:07 实测，守护检测到应用死亡并报告 `relaunched`，但复活的实例
//       一行日志都没写，隔离目录里启动计数停在 1 —— 自恢复看着成功，实际没恢复。
// 根因：打包后没有独立的 node，守护只能用主二进制 + ELECTRON_RUN_AS_NODE=1 当运行时
//       （electron/main.ts 的 relaunch-guard.cmd）。spawn 新实例时这个变量被原样继承，
//       于是"应用"以 Node 模式启动：没有 Electron 初始化、没有窗口，立刻退出。
// 为什么不能换写法：守护自身必须保留该变量才能运行，所以只能在交给子进程的那份环境里
//       删掉它 —— 置空字符串不行，Electron 只看变量是否存在。
test('the relaunched app does not inherit the guard node-mode flag', () => {
  const env = buildRelaunchEnv({
    ELECTRON_RUN_AS_NODE: '1',
    CHILL_VIBE_DATA_DIR: 'D:\\data',
    PATH: 'C:\\Windows',
  })
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(env.CHILL_VIBE_DATA_DIR, 'D:\\data')
  assert.equal(env.PATH, 'C:\\Windows')
})

test('building the relaunch env leaves the guard own environment untouched', () => {
  const source = { ELECTRON_RUN_AS_NODE: '1', KEEP: 'yes' }
  buildRelaunchEnv(source)
  assert.equal(source.ELECTRON_RUN_AS_NODE, '1')
})

// 2026-11-20 审查 + 本机（ACP/OEMCP=936）实测：路径以 UTF-8 写进 relaunch-guard.cmd，
// 由 detached cmd 解析时按 936 解码成乱码，守护从未起来；批处理首行加 chcp 65001
// 也无效（detached 的 cmd 没有控制台）。所以路径必须完全不进批处理文件。
const launcherPaths = (root: string) => ({
  execPath: path.join(root, 'Chill Vibe.exe'),
  guardScript: path.join(root, 'resources', 'crash-relaunch-guard-main.mjs'),
  pipePath: '\\\\.\\pipe\\chill-vibe-relaunch-5960',
  sentinelPath: path.join(root, 'data', 'run-sentinel.json'),
  historyPath: path.join(root, 'data', 'relaunch-history.json'),
})

for (const root of [['D:', '中文 目录', 'Chill Vibe IDE'].join('\\'), 'C:\\Program Files\\Chill Vibe IDE']) {
  test(`the relaunch guard launcher script stays ASCII and carries paths out of band (${root})`, () => {
    const paths = launcherPaths(root)
    const launcher = buildRelaunchGuardLauncher(paths)

    // eslint-disable-next-line no-control-regex -- the whole file must be 7-bit ASCII
    assert.match(launcher.script, /^[\x00-\x7f]*$/)
    for (const value of Object.values(paths)) {
      assert.equal(launcher.script.includes(value), false)
      assert.ok(Object.values(launcher.env).includes(value))
    }
    assert.match(launcher.script, /^@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n/)
    assert.match(launcher.script, /start "" \/b /)
  })
}

const runLauncherForReal = process.platform === 'win32' ? test : test.skip

for (const dirName of ['中文 下载', 'plain dir']) {
  runLauncherForReal(`the relaunch guard launcher really starts the guard from a "${dirName}" install`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cv-guard-launcher-'))
    try {
      const installDir = path.join(root, dirName)
      await mkdir(installDir, { recursive: true })
      const probeScript = path.join(installDir, 'probe-guard.mjs')
      const markerPath = path.join(installDir, 'marker.json')
      // The probe stands in for crash-relaunch-guard-main.mjs: it records exactly
      // what the guard would have received.
      await writeFile(
        probeScript,
        [
          "import { writeFileSync } from 'node:fs'",
          'const leaked = Object.keys(process.env).filter((key) => key.startsWith("CHILL_VIBE_GUARD_LAUNCH_"))',
          `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ argv: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, leaked }))`,
        ].join('\n'),
      )
      const paths = {
        execPath: process.execPath,
        guardScript: probeScript,
        pipePath: '\\\\.\\pipe\\chill-vibe-relaunch-5960',
        sentinelPath: path.join(installDir, 'run-sentinel.json'),
        historyPath: path.join(installDir, 'relaunch-history.json'),
      }
      const launcher = buildRelaunchGuardLauncher(paths)
      const launcherPath = path.join(installDir, 'relaunch-guard.cmd')
      await writeFile(launcherPath, launcher.script, 'utf8')

      // Same spawn shape as electron/main.ts spawnCrashRelaunchGuard.
      const child = spawn(process.env.COMSPEC ?? 'cmd.exe', ['/c', launcherPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ...launcher.env },
      })
      child.unref()

      let marker: string | null = null
      for (let attempt = 0; attempt < 100 && marker === null; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        marker = await readFile(markerPath, 'utf8').catch(() => null)
      }
      assert.ok(marker, 'the guard process never started')
      const recorded = JSON.parse(marker) as { argv: string[]; runAsNode: string | null; leaked: string[] }
      assert.deepEqual(recorded.argv, [
        '--pipe',
        paths.pipePath,
        '--sentinel',
        paths.sentinelPath,
        '--history',
        paths.historyPath,
        '--exec',
        paths.execPath,
      ])
      assert.equal(recorded.runAsNode, '1')
      assert.deepEqual(recorded.leaked, [])
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
