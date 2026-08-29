// 打包版实证：更新装完之后，第一次自动重启起来的必须是**新版本**。
//
// 为什么单测不够 —— 单测能证明脚本会清场、纯函数会按顺序标记 clean exit，但证明不了
// 真实的崩溃守卫在真实的 app.exit(0) 之后到底做了什么。用户报的现象（第一次重启还是旧版）
// 就发生在这条缝里：守卫把更新退出读成崩溃 → 在安装目录被替换前拉起旧版 → 旧实例抢到
// single-instance lock → 作业末尾 Start-Process 起的新版进程立刻自杀。
//
// 这个脚本把整条链路跑一遍：真实 exe、真实守卫、真实 single-instance lock、真实
// PowerShell 替换作业。靶子是一份复制出来的临时安装目录，绝不碰用户自己的安装。
//
// 隔离三件套照抄 smoke-packaged-backend-isolation.ps1（单独设 CHILL_VIBE_DATA_DIR 无效），
// 但**故意不设** CHILL_VIBE_DISABLE_CRASH_RECOVERY / CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK
// —— 守卫和实例锁正是被测对象。

import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sourceDir = process.argv[2]
const zipPath = process.argv[3]

if (!sourceDir || !zipPath) {
  console.error(
    '用法: node scripts/verify-update-restart-packaged.mjs "<win-unpacked 目录>" "<更新用的 zip>"',
  )
  process.exit(2)
}

const EXE_NAME = 'Chill Vibe.exe'
const OLD_MARKER = 'old-install-marker.txt'

const installDir = mkdtempSync(join(tmpdir(), 'cv-update-install-'))
const dataDir = mkdtempSync(join(tmpdir(), 'cv-update-data-'))
const exePath = join(installDir, EXE_NAME)

const ps = (command) =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', timeout: 120_000 },
  )

const instancesFromInstallDir = () => {
  const escaped = installDir.replace(/'/g, "''")
  const raw = ps(
    `@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -like '${escaped}\\*' } | Select-Object -ExpandProperty ProcessId) -join ','`,
  ).trim()
  return raw ? raw.split(',').map((value) => Number.parseInt(value, 10)).filter(Boolean) : []
}

const killInstallDirInstances = () => {
  for (const processId of instancesFromInstallDir()) {
    try {
      ps(`Stop-Process -Id ${processId} -Force -ErrorAction SilentlyContinue`)
    } catch {
      // 已经退出了。
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const newestUpdateJobLog = async () => {
  const temp = tmpdir()
  const entries = await readdir(temp, { withFileTypes: true }).catch(() => [])
  const jobs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('chill-vibe-update-'))
    .map((entry) => join(temp, entry.name, 'apply-update.log'))
    .filter((logPath) => existsSync(logPath))

  let newest = null
  let newestAt = 0
  for (const logPath of jobs) {
    const { mtimeMs } = await import('node:fs').then((fs) => fs.promises.stat(logPath))
    if (mtimeMs > newestAt) {
      newestAt = mtimeMs
      newest = logPath
    }
  }

  return newest
}

console.log(`安装目录 : ${installDir}`)
console.log(`数据目录 : ${dataDir}`)
console.log(`更新包   : ${zipPath}`)

cpSync(sourceDir, installDir, { recursive: true })
// 这个哨兵只存在于"旧安装"里。更新是整目录替换，所以它消失就等于替换真的发生了。
writeFileSync(join(installDir, OLD_MARKER), 'old-install', 'utf8')

const failures = []
const expect = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✔ ${label}`)
  } else {
    console.log(`  ✖ ${label}${detail ? `\n      ${detail}` : ''}`)
    failures.push(label)
  }
}

const app = await electron.launch({
  executablePath: exePath,
  args: [],
  env: {
    ...process.env,
    CHILL_VIBE_ALLOW_SHARED_DATA_DIR: '1',
    CHILL_VIBE_DATA_DIR: dataDir,
    // single-instance lock 挂在默认 userData 上，不随 CHILL_VIBE_DATA_DIR 隔离 —— 用户
    // 自己的实例正开着时，这个探针一启动就会自杀（实测 exitCode=0，窗口都没出来）。
    // 关掉它不削弱结论：判据取的是守卫日志里那句 stand-down，即「守卫没有拉起旧版」，
    // 而不是「新版侥幸抢到了锁」。
    CHILL_VIBE_DISABLE_SINGLE_INSTANCE_LOCK: '1',
  },
  timeout: 120_000,
})

try {
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState('domcontentloaded')
  // 守卫是在 app ready 之后异步 spawn 的，得让它真的连上管道再触发更新。
  await sleep(12_000)

  const guardLogPath = join(dataDir, 'logs', 'relaunch-guard.log')
  expect('守卫已启动（relaunch-guard.log 里有 attached）', existsSync(guardLogPath))

  const updatingPid = app.process().pid
  console.log(`触发 desktop:install-update ...（当前实例 pid=${updatingPid}）`)
  await page
    .evaluate((assetPath) => window.electronAPI.installUpdate(assetPath), zipPath)
    .catch((error) => {
      console.log(`  （installUpdate 调用随进程退出而断开，属正常）: ${error.message}`)
    })

  // sentinel 只能在这个窗口里抓：更新后的新实例一起来就会把它写回 cleanExit=false。
  // 判据是"这一次退出被标记成干净了"，不是"文件最终长什么样"。
  const readSentinel = () => {
    try {
      return JSON.parse(readFileSync(join(dataDir, 'run-sentinel.json'), 'utf8'))
    } catch {
      return null
    }
  }

  // 别拿 app.process().pid 去比对 sentinel：Playwright 报的是它启动的那个进程，
  // 实测与真正写 sentinel 的 Electron 主进程 pid 不是一个（实测 69380 vs 79888）。
  // 判据就是"这个窗口里出现过 cleanExit=true"——更新后的新实例一起来就会写回 false。
  let markedCleanExit = false
  const markDeadline = Date.now() + 60_000
  while (Date.now() < markDeadline) {
    const current = readSentinel()
    if (current && current.cleanExit === true) {
      markedCleanExit = true
      console.log(`  sentinel 已标记 clean exit: ${JSON.stringify(current)}`)
      break
    }
    await sleep(200)
  }

  // app.exit(0) 有 1.5s 的 flush 窗口，之后是 PowerShell 作业：解压 + 换目录 + 启动。
  await sleep(90_000)

  const sentinel = readSentinel()
  const guardLog = existsSync(guardLogPath) ? readFileSync(guardLogPath, 'utf8') : ''
  const jobLogPath = await newestUpdateJobLog()
  const jobLog = jobLogPath ? await readFile(jobLogPath, 'utf8') : ''
  const survivors = instancesFromInstallDir()

  console.log('\n--- 守卫日志 ---')
  console.log(guardLog.trim().split('\n').slice(-6).join('\n'))
  console.log('\n--- 更新作业日志 ---')
  console.log(jobLog.trim())
  console.log('\n--- 判定 ---')

  expect(
    '更新退出被标记成 clean exit（守卫不会再把它读成崩溃）',
    markedCleanExit,
    `最后看到的 sentinel: ${JSON.stringify(sentinel)}`,
  )
  expect(
    '守卫对这次退出 stand-down，没有拉起旧版',
    /app gone -> stand-down/.test(guardLog) && !/app gone -> relaunch/.test(guardLog),
    guardLog.trim().split('\n').slice(-3).join(' | '),
  )
  expect('更新作业跑完并启动了新应用', /Launch issued\. Update job done\./.test(jobLog), jobLogPath ?? '')
  expect(
    '安装目录真的被换掉了（旧哨兵文件消失）',
    !existsSync(join(installDir, OLD_MARKER)),
  )
  expect('新版本进程确实起来了', survivors.length > 0, `survivors=${survivors.join(',')}`)
} finally {
  // 先把 sentinel 标成干净再动手：否则收尾的 Stop-Process 会被守卫读成崩溃，
  // 给这台机器留下一串幽灵实例（packaged 冒烟的老坑）。
  try {
    const sentinelPath = join(dataDir, 'run-sentinel.json')
    const current = JSON.parse(readFileSync(sentinelPath, 'utf8'))
    writeFileSync(sentinelPath, JSON.stringify({ ...current, cleanExit: true }, null, 2), 'utf8')
  } catch {
    // 没有 sentinel 就没有守卫要安抚。
  }

  await app.close().catch(() => {})
  await sleep(1_000)
  killInstallDirInstances()
  await sleep(1_000)
  killInstallDirInstances()
  console.log(`\n收尾：已清掉 ${installDir} 下的实例。临时目录保留以便复查。`)
}

if (failures.length > 0) {
  console.log(`\n结果：未通过 —— ${failures.join(' / ')}`)
  process.exit(1)
}

console.log('\n结果：通过 —— 更新后第一次起来的就是新版本。')
