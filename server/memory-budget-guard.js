import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'

// AI 内存预算（docs/specs/agent-memory-budget）：agent 要跑「会启动重任务」的 shell 命令前，
// 由 PreToolUse 钩子检查整机资源，超标就以退出码 2 拒绝并把原因告诉 agent。
// 症状：2026-11-27 实测同时 28 个 node 进程、`sim.mjs 16` 占 2.8GB、全仓 eslint 2.4GB，
//   可提交内存只剩 15.7GB，整机卡顿；CLAUDE.md 里「别跑卡电脑」的软约定挡不住。
// 被否决的替代：限制会话数 / provider 排队（docs/specs/provider-run-resource-guard 明确不做）；
//   这里只在资源已经紧张时拒绝「新的重任务命令」，轻命令与 kill 永远放行，探测失败一律放行。

export const memoryBudgetStderrMarker = 'CHILL_VIBE_MEMORY_BUDGET_BLOCK'
export const defaultMemoryBudget = Object.freeze({ minFreeGb: 8, minCommitGb: 8, maxHeavyProcesses: 8 })
export const heavyProcessMinWorkingSetBytes = 200 * 1024 * 1024
export const memoryProbeTimeoutMs = 3000

const gib = 1024 ** 3
const topProcessLimit = 5

// 计入「重进程」的进程名（Windows 进程名不带 .exe）。
const heavyProcessNames = [
  'node', 'electron', 'python', 'python3', 'pythonw', 'java', 'javaw', 'deno', 'bun',
  'headless_shell', 'chrome-headless-shell',
]
const heavyProcessNamePattern = /^(?:node|nodejs|electron|python[\d.]*w?|java|javaw|deno|bun|headless_shell|chrome-headless-shell)$/i

// 会启动重任务的命令名。只认「段首真正执行的命令」，不认参数里出现的同名词
// （`Get-Process node`、`rg node src`、`taskkill /im node.exe` 都是轻命令）。
const heavyCommandNames = new Set([
  'node', 'nodejs', 'npm', 'pnpm', 'npx', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'deno',
  'tsx', 'ts-node', 'tsc', 'vite', 'vitest', 'jest', 'mocha', 'ava', 'playwright', 'eslint',
  'electron', 'electron-builder', 'tsup', 'webpack', 'rollup', 'next', 'nuxt', 'turbo', 'nx', 'lerna',
  'python', 'python3', 'pythonw', 'py', 'pip', 'pip3', 'pytest', 'uv', 'uvx', 'poetry', 'conda',
  'java', 'javac', 'gradle', 'gradlew', 'mvn', 'mvnw', 'cargo', 'rustc', 'go', 'dotnet', 'msbuild',
])
const pythonVersionedPattern = /^python\d+(?:\.\d+)*w?$/
const scriptFilePattern = /\.(?:js|mjs|cjs|ts|mts|cts|py)$/i

// 前缀命令：跳过它和它的选项 / 数字参数，再看后面真正执行的是什么。
const prefixCommandNames = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'setsid',
  'unbuffer', 'exec', 'command', 'builtin', 'call', 'start', 'start-process', 'saps',
  'start-job', 'invoke-command', 'measure-command',
])
const versionOnlyArgumentPattern = /^(?:-v|-V|--version|-version|version|--help|-h|help|-\?|\/\?)$/

const tokenPattern = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s]+/g

const stripQuotes = (value) => {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

const tokenizeSegment = (segment) => [...segment.matchAll(tokenPattern)].map((match) => stripQuotes(match[0]))

const commandNameOf = (value) =>
  value.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '')

const isSkippableToken = (token) =>
  token === '' ||
  token === '&' ||
  token === '.' ||
  token === '@' ||
  /^[A-Za-z_]\w*=/.test(token)

const isSegmentHeavy = (segment) => {
  const tokens = tokenizeSegment(segment)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (isSkippableToken(token)) {
      index += 1
      continue
    }
    const name = commandNameOf(token)
    if (prefixCommandNames.has(name)) {
      index += 1
      while (
        index < tokens.length &&
        (isSkippableToken(tokens[index]) || /^[-/]/.test(tokens[index]) || /^\d+[smhd]?$/i.test(tokens[index]))
      ) {
        index += 1
      }
      continue
    }
    if (heavyCommandNames.has(name) || pythonVersionedPattern.test(name)) {
      const rest = tokens.slice(index + 1).filter((entry) => entry !== '')
      return !(rest.length > 0 && rest.every((entry) => versionOnlyArgumentPattern.test(entry)))
    }
    return scriptFilePattern.test(token)
  }
  return false
}

/** 任一子命令段会启动重任务即为真；入参是守卫已展开包装层（bash -c / powershell -Command…）后的子命令段。 */
export const isHeavyShellCommand = (segments) => segments.some((segment) => isSegmentHeavy(segment))

const parsePositiveNumber = (value, fallback, { integer = false, max = Infinity } = {}) => {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && parsed < 1)) {
    return fallback
  }
  const bounded = Math.min(parsed, max)
  return integer ? Math.round(bounded) : bounded
}

/** 只有 IDE 显式下发 CHILL_VIBE_MEMORY_BUDGET_ENABLED=1 才启用；非法阈值回落默认值。 */
export const readMemoryBudgetFromEnv = (env = process.env) => {
  if (env.CHILL_VIBE_MEMORY_BUDGET_ENABLED !== '1') {
    return null
  }
  return {
    minFreeGb: parsePositiveNumber(env.CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB, defaultMemoryBudget.minFreeGb, { max: 1024 }),
    minCommitGb: parsePositiveNumber(env.CHILL_VIBE_MEMORY_BUDGET_MIN_COMMIT_GB, defaultMemoryBudget.minCommitGb, { max: 1024 }),
    maxHeavyProcesses: parsePositiveNumber(
      env.CHILL_VIBE_MEMORY_BUDGET_MAX_HEAVY_PROCESSES,
      defaultMemoryBudget.maxHeavyProcesses,
      { integer: true, max: 1000 },
    ),
  }
}

const formatGb = (bytes) => `${(bytes / gib).toFixed(1)} GB`

const summarizeCommandLine = (value, maxLength = 160) => {
  const singleLine = String(value ?? '').replace(/\s+/g, ' ').trim()
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** 纯函数：snapshot 中为 null 的指标视为「本平台测不到」，不参与判定。 */
export const evaluateMemoryBudget = (snapshot, budget) => {
  const freeLow = isFiniteNumber(snapshot.freeBytes) && snapshot.freeBytes < budget.minFreeGb * gib
  const commitLow =
    isFiniteNumber(snapshot.commitAvailableBytes) && snapshot.commitAvailableBytes < budget.minCommitGb * gib
  const tooMany =
    isFiniteNumber(snapshot.heavyProcessCount) && snapshot.heavyProcessCount > budget.maxHeavyProcesses
  if (!freeLow && !commitLow && !tooMany) {
    return { allowed: true }
  }

  const mark = (exceeded) => (exceeded ? '（超标）' : '')
  const metrics = [
    isFiniteNumber(snapshot.freeBytes)
      ? `空闲物理内存 ${formatGb(snapshot.freeBytes)}（下限 ${budget.minFreeGb} GB）${mark(freeLow)}`
      : null,
    isFiniteNumber(snapshot.commitAvailableBytes)
      ? `剩余可提交内存 ${formatGb(snapshot.commitAvailableBytes)}（下限 ${budget.minCommitGb} GB）${mark(commitLow)}`
      : null,
    isFiniteNumber(snapshot.heavyProcessCount)
      ? `重进程（≥200MB 的 node/electron/python 等）${snapshot.heavyProcessCount} 个（上限 ${budget.maxHeavyProcesses}）${mark(tooMany)}`
      : null,
  ].filter(Boolean)

  const lines = [
    memoryBudgetStderrMarker,
    'Chill Vibe 内存预算：整机资源紧张，已暂缓这条会启动重任务的命令（命令未执行）。',
    `当前：${metrics.join(' / ')}。`,
  ]
  const top = Array.isArray(snapshot.topProcesses) ? snapshot.topProcesses.slice(0, topProcessLimit) : []
  if (top.length > 0) {
    lines.push('占用最大的进程：')
    for (const entry of top) {
      const commandLine = summarizeCommandLine(entry.commandLine)
      lines.push(
        `- ${entry.name} ${formatGb(entry.workingSetBytes)}  pid ${entry.pid}${commandLine ? `  ${commandLine}` : ''}`,
      )
    }
  }
  lines.push(
    '请这样处理：1) 等一会儿再试（其它会话的任务结束后内存会释放）；2) 降低并发（例如 16 路改成 2~4 路，--max-old-space-size 不超过 3000，别跑全仓 eslint）；3) 如果上面有你自己这个会话之前启动、已经不需要的进程，先停掉它再重试。',
    '不要结束其它会话启动的进程（不是你启动的就别动）。查看 / 结束进程、git、读文件等轻命令不受限制。',
  )
  return { allowed: false, reason: lines.join('\n') }
}

const toNumberOrNull = (value) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

const runCommand = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    let child
    try {
      child = execFile(
        file,
        args,
        { windowsHide: true, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => finish(error ? null : stdout),
      )
    } catch {
      finish(null)
      return
    }
    // execFile 的 timeout 只负责杀子进程；再兜一层，保证本 Promise 一定按时落地（fail-open）。
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL')
      } catch {
        // ignore
      }
      finish(null)
    }, timeoutMs + 100)
    timer.unref?.()
  })

// 2026-11-27 本机实测：Get-WmiObject 比 Get-CimInstance 少约 100ms 的模块加载；Get-Process 拿工作集
// 很快，命令行只在超标时才按 pid 精确查前 5 个（放行路径约 450ms，超标路径约 950ms；
// 全量 Get-CimInstance Win32_Process 约 1s，PerformanceCounter 约 6.4s）。
const buildWindowsProbeScript = (budget) => {
  const minFreeBytes = Math.round(budget.minFreeGb * gib)
  const minCommitBytes = Math.round(budget.minCommitGb * gib)
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$o=Get-WmiObject Win32_OperatingSystem -Property FreePhysicalMemory,FreeVirtualMemory',
    `$p=@(Get-Process -Name ${heavyProcessNames.join(',')} | Where-Object { $_.WorkingSet64 -ge ${heavyProcessMinWorkingSetBytes} } | Sort-Object WorkingSet64 -Descending)`,
    '$free=$null;$commit=$null',
    'if($o){$free=[double]$o.FreePhysicalMemory*1024;$commit=[double]$o.FreeVirtualMemory*1024}',
    `$t=@($p | Select-Object -First ${topProcessLimit})`,
    '$c=@{}',
    `$over=(($free -ne $null -and $free -lt ${minFreeBytes}) -or ($commit -ne $null -and $commit -lt ${minCommitBytes}) -or $p.Count -gt ${budget.maxHeavyProcesses})`,
    "if($over -and $t.Count -gt 0){Get-WmiObject Win32_Process -Filter (($t|ForEach-Object{\"ProcessId=$($_.Id)\"}) -join ' OR ') -Property ProcessId,CommandLine | ForEach-Object { $c[[int]$_.ProcessId]=$_.CommandLine }}",
    '@{free=$free;commit=$commit;count=$p.Count;top=@($t|ForEach-Object{@{pid=$_.Id;name=$_.ProcessName;ws=[double]$_.WorkingSet64;cmd=$c[[int]$_.Id]}})}|ConvertTo-Json -Compress -Depth 4',
  ].join('\n')
}

const probeWindows = async (budget, timeoutMs) => {
  const encoded = Buffer.from(buildWindowsProbeScript(budget), 'utf16le').toString('base64')
  const stdout = await runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    timeoutMs,
  )
  if (!stdout || !stdout.trim()) {
    return null
  }
  const parsed = JSON.parse(stdout.trim())
  const top = Array.isArray(parsed.top) ? parsed.top : parsed.top ? [parsed.top] : []
  return {
    freeBytes: toNumberOrNull(parsed.free) ?? os.freemem(),
    commitAvailableBytes: toNumberOrNull(parsed.commit),
    heavyProcessCount: toNumberOrNull(parsed.count) ?? 0,
    topProcesses: top.map((entry) => ({
      pid: toNumberOrNull(entry.pid) ?? 0,
      name: String(entry.name ?? ''),
      workingSetBytes: toNumberOrNull(entry.ws) ?? 0,
      commandLine: typeof entry.cmd === 'string' ? entry.cmd : '',
    })),
  }
}

const readLinuxCommitAvailable = async () => {
  const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
  const limit = meminfo.match(/^CommitLimit:\s+(\d+)\s+kB/m)
  const committed = meminfo.match(/^Committed_AS:\s+(\d+)\s+kB/m)
  if (!limit || !committed) {
    return null
  }
  return (Number(limit[1]) - Number(committed[1])) * 1024
}

const probePosix = async (platform, timeoutMs) => {
  const stdout = await runCommand('ps', ['-axww', '-o', 'pid=,rss=,args='], timeoutMs)
  if (stdout === null) {
    return null
  }
  const heavy = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const workingSetBytes = Number(match[2]) * 1024
    const executable = match[3].split(/\s+/)[0] ?? ''
    const name = executable.replace(/^.*\//, '')
    if (workingSetBytes >= heavyProcessMinWorkingSetBytes && heavyProcessNamePattern.test(name)) {
      heavy.push({ pid: Number(match[1]), name, workingSetBytes, commandLine: match[3] })
    }
  }
  heavy.sort((left, right) => right.workingSetBytes - left.workingSetBytes)
  return {
    freeBytes: os.freemem(),
    commitAvailableBytes: platform === 'linux' ? await readLinuxCommitAvailable() : null,
    heavyProcessCount: heavy.length,
    topProcesses: heavy.slice(0, topProcessLimit),
  }
}

/** 探测整机资源；任何失败或超时返回 null（调用方必须放行）。 */
export const probeSystemMemory = async ({
  budget = defaultMemoryBudget,
  platform = process.platform,
  timeoutMs = memoryProbeTimeoutMs,
} = {}) => {
  const deadline = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    timer.unref?.()
  })
  const probe = (async () => {
    try {
      return platform === 'win32' ? await probeWindows(budget, timeoutMs) : await probePosix(platform, timeoutMs)
    } catch {
      return null
    }
  })()
  return Promise.race([probe, deadline])
}
