import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateToolUse,
  isHeavyShellToolCommand,
} from '../server/codex-destructive-command-guard.js'
import {
  evaluateMemoryBudget,
  memoryBudgetStderrMarker,
  probeSystemMemory,
  readMemoryBudgetFromEnv,
  type MemoryBudget,
  type MemorySnapshot,
} from '../server/memory-budget-guard.js'

const gb = 1024 ** 3

const budget: MemoryBudget = { minFreeGb: 8, minCommitGb: 8, maxHeavyProcesses: 8 }

const budgetEnv = {
  CHILL_VIBE_MEMORY_BUDGET_ENABLED: '1',
  CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB: '8',
  CHILL_VIBE_MEMORY_BUDGET_MIN_COMMIT_GB: '8',
  CHILL_VIBE_MEMORY_BUDGET_MAX_HEAVY_PROCESSES: '8',
  // 本测试可能由 Chill Vibe 会话启动，显式关掉其它守卫，避免继承真实开关（pitfall #208 同类）。
  CHILL_VIBE_ATTACK_PATTERN_PROTECTION_ENABLED: '0',
  CHILL_VIBE_DESTRUCTIVE_COMMAND_PROTECTION_ENABLED: '0',
  CHILL_VIBE_OUTSIDE_WORKSPACE_WRITE_ENABLED: '1',
}

const tightSnapshot: MemorySnapshot = {
  freeBytes: 5.2 * gb,
  commitAvailableBytes: 6.1 * gb,
  heavyProcessCount: 11,
  topProcesses: [
    {
      pid: 42976,
      name: 'node',
      workingSetBytes: 2.7 * gb,
      commandLine: '"D:\\Program Files\\nodejs\\node.exe" tools/sim.mjs 16 --avail --honest',
    },
    { pid: 15892, name: 'node', workingSetBytes: 1.3 * gb, commandLine: 'node eslint.js .' },
  ],
}

const roomySnapshot: MemorySnapshot = {
  freeBytes: 30 * gb,
  commitAvailableBytes: 40 * gb,
  heavyProcessCount: 2,
  topProcesses: [],
}

test('heavy launch commands are recognised, including wrappers and prefixes', () => {
  for (const command of [
    'pnpm test',
    'npm run build',
    'npx vitest run',
    'node tools/sim.mjs 16',
    'node --max-old-space-size=3000 scripts/host1.mjs',
    'python -m pytest',
    'py script.py',
    'pnpm exec playwright test tests/theme-check.spec.ts',
    'eslint .',
    'tsc --noEmit',
    '.\\node_modules\\.bin\\vitest.cmd run',
    '& "C:\\Program Files\\nodejs\\node.exe" sim.mjs',
    'cd D:\\Git\\repo && pnpm test:quality',
    'git status; pnpm build',
    'bash -c "npm test"',
    'powershell -NoProfile -Command "pnpm lint"',
    'cmd /c "yarn build"',
    'Start-Process -FilePath node -ArgumentList sim.mjs',
    'start "" node sim.mjs',
    'timeout 600 node sim.mjs',
    'nohup python train.py &',
    'NODE_OPTIONS=--max-old-space-size=4096 node build.mjs',
    'env FOO=1 pnpm dev',
    './tools/sim.mjs 16',
    'electron .',
    'cargo build',
    'go test ./...',
  ]) {
    assert.equal(isHeavyShellToolCommand(command), true, command)
  }
})

test('light commands, version queries and process management stay allowed', () => {
  for (const command of [
    'git status',
    'git log --oneline -5',
    'ls -la',
    'Get-ChildItem',
    'cat package.json',
    'Get-Content AGENTS.md -TotalCount 20',
    'rg node src',
    'grep -rn "node" server',
    'Get-Process node',
    'Get-Process node | Where-Object WorkingSet64 -gt 200MB',
    'tasklist /fi "imagename eq node.exe"',
    'taskkill /pid 42976 /f',
    'taskkill /im node.exe /f',
    'Stop-Process -Id 42976 -Force',
    'Get-Process node | Stop-Process',
    'kill -9 42976',
    'pkill -f sim.mjs',
    'node --version',
    'pnpm -v',
    'python --version',
    'where node',
    'which pnpm',
    'Get-Command node',
    'echo done',
  ]) {
    assert.equal(isHeavyShellToolCommand(command), false, command)
  }
})

test('evaluateMemoryBudget explains every exceeded limit with numbers and top processes', () => {
  const verdict = evaluateMemoryBudget(tightSnapshot, budget)
  assert.equal(verdict.allowed, false)
  const reason = verdict.reason ?? ''
  assert.match(reason, /5\.2 GB/)
  assert.match(reason, /6\.1 GB/)
  assert.match(reason, /11/)
  assert.match(reason, /sim\.mjs 16/)
  assert.match(reason, /42976/)
  // 要求等待 / 降并发 / 只停自己的进程，且明确不许杀别的会话的进程。
  assert.match(reason, /等/)
  assert.match(reason, /并发/)
  assert.match(reason, /不要结束其它会话/)

  assert.deepEqual(evaluateMemoryBudget(roomySnapshot, budget), { allowed: true })
})

test('evaluateMemoryBudget skips metrics the platform could not measure', () => {
  assert.deepEqual(
    evaluateMemoryBudget({ ...roomySnapshot, commitAvailableBytes: null }, budget),
    { allowed: true },
  )
  const onlyProcesses = evaluateMemoryBudget(
    { ...roomySnapshot, commitAvailableBytes: null, heavyProcessCount: 9 },
    budget,
  )
  assert.equal(onlyProcesses.allowed, false)
  assert.match(onlyProcesses.reason ?? '', /9/)
})

test('readMemoryBudgetFromEnv only enables the budget when the IDE says so', () => {
  assert.equal(readMemoryBudgetFromEnv({}), null)
  assert.equal(readMemoryBudgetFromEnv({ ...budgetEnv, CHILL_VIBE_MEMORY_BUDGET_ENABLED: '0' }), null)
  assert.deepEqual(readMemoryBudgetFromEnv(budgetEnv), budget)
  assert.deepEqual(
    readMemoryBudgetFromEnv({
      CHILL_VIBE_MEMORY_BUDGET_ENABLED: '1',
      CHILL_VIBE_MEMORY_BUDGET_MIN_FREE_GB: 'abc',
      CHILL_VIBE_MEMORY_BUDGET_MIN_COMMIT_GB: '-3',
      CHILL_VIBE_MEMORY_BUDGET_MAX_HEAVY_PROCESSES: '',
    }),
    budget,
  )
})

const shellInput = (command: string, toolName = 'Bash') => ({
  tool_name: toolName,
  tool_input: { command },
  cwd: process.cwd(),
})

test('guard blocks heavy shell commands with exit code 2 when the machine is over budget', async () => {
  let probes = 0
  const probe = async () => {
    probes += 1
    return tightSnapshot
  }
  const verdict = await evaluateToolUse(shellInput('pnpm test'), { env: budgetEnv, probeMemory: probe })
  assert.equal(verdict?.exitCode, 2)
  assert.ok(verdict?.reason.startsWith(memoryBudgetStderrMarker))
  assert.match(verdict?.reason ?? '', /5\.2 GB/)

  // Claude Code 在 Windows 上有原生 PowerShell 工具，Gemini 是 run_shell_command。
  for (const toolName of ['PowerShell', 'run_shell_command', 'shell', 'exec_command']) {
    const other = await evaluateToolUse(shellInput('pnpm test', toolName), { env: budgetEnv, probeMemory: probe })
    assert.equal(other?.exitCode, 2, toolName)
  }

  // 轻命令和文件工具根本不探测。
  const before = probes
  assert.equal(await evaluateToolUse(shellInput('git status'), { env: budgetEnv, probeMemory: probe }), null)
  assert.equal(await evaluateToolUse(shellInput('taskkill /pid 1 /f'), { env: budgetEnv, probeMemory: probe }), null)
  assert.equal(
    await evaluateToolUse(
      { tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'x' }, cwd: process.cwd() },
      { env: budgetEnv, probeMemory: probe },
    ),
    null,
  )
  assert.equal(probes, before)
})

test('guard fails open when the budget is off, the machine is fine, or probing fails', async () => {
  const tight = async () => tightSnapshot
  assert.equal(
    await evaluateToolUse(shellInput('pnpm test'), {
      env: { ...budgetEnv, CHILL_VIBE_MEMORY_BUDGET_ENABLED: '0' },
      probeMemory: tight,
    }),
    null,
  )
  assert.equal(
    await evaluateToolUse(shellInput('pnpm test'), { env: budgetEnv, probeMemory: async () => roomySnapshot }),
    null,
  )
  assert.equal(
    await evaluateToolUse(shellInput('pnpm test'), { env: budgetEnv, probeMemory: async () => null }),
    null,
  )
  assert.equal(
    await evaluateToolUse(shellInput('pnpm test'), {
      env: budgetEnv,
      probeMemory: async () => {
        throw new Error('probe crashed')
      },
    }),
    null,
  )
})

test('probeSystemMemory returns a real snapshot on this machine within the time limit', async () => {
  const startedAt = Date.now()
  const snapshot = await probeSystemMemory({ budget, timeoutMs: 4000 })
  const elapsedMs = Date.now() - startedAt
  assert.ok(snapshot, 'probe should succeed on a normal dev machine')
  assert.ok((snapshot.freeBytes ?? 0) > 0)
  assert.ok((snapshot.heavyProcessCount ?? -1) >= 0)
  assert.ok(elapsedMs < 4000, `probe took ${elapsedMs}ms`)
  if (process.platform === 'win32' || process.platform === 'linux') {
    assert.ok((snapshot.commitAvailableBytes ?? 0) > 0)
  }
})

test('probeSystemMemory fails open (null) when it cannot finish in time', async () => {
  assert.equal(await probeSystemMemory({ budget, timeoutMs: 1 }), null)
})
