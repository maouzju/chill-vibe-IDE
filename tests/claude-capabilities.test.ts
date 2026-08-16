import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  findUnsupportedClaudeFlags,
  getClaudeSupportedFlags,
  parseClaudeSupportedFlags,
  resetClaudeCapabilityCacheForTests,
} from '../server/claude-capabilities.ts'

// 2026-08-16 实测 `claude --help`（2.1.206）的真实排版。三种形态都要能解析：
// 单长参数、短+长别名、双长别名。
const realHelpExcerpt = `Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --agent <agent>                       Agent for the current session.
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>       Append a system prompt
  -c, --continue                        Continue the most recent conversation
  -d, --debug [filter]                  Enable debug mode
  --effort <level>                      Reasoning effort
  -p, --print                           Print response and exit
`

test('the help text yields every flag the CLI actually accepts', () => {
  const flags = parseClaudeSupportedFlags(realHelpExcerpt)

  assert.ok(flags.has('--add-dir'))
  assert.ok(flags.has('--append-system-prompt'))
  assert.ok(flags.has('--effort'))
  // 短别名与它的长名要同时收录，否则 `-p` 会被误报成不支持。
  assert.ok(flags.has('-p'))
  assert.ok(flags.has('--print'))
  assert.ok(flags.has('-c'))
  assert.ok(flags.has('--continue'))
  // 双长别名同一行的形态。
  assert.ok(flags.has('--allowedTools'))
  assert.ok(flags.has('--allowed-tools'))
})

test('prose in the help body is not mistaken for a flag', () => {
  const flags = parseClaudeSupportedFlags(realHelpExcerpt)

  // 描述文字里的普通单词、以及 Usage 行，都不该变成"支持的参数"。
  assert.equal(flags.has('--Comma'), false)
  assert.equal(flags.has('--options'), false)
  assert.ok(flags.size > 0 && flags.size < 30)
})

test('an unparseable help output yields nothing rather than a bogus allowlist', () => {
  // 关键的 fail-open 前提：解析不出来必须是空集，调用方据此**跳过校验**。
  // 若这里返回半个清单，我们会把一堆合法参数误报成不支持。
  assert.equal(parseClaudeSupportedFlags('').size, 0)
  assert.equal(parseClaudeSupportedFlags('command not found').size, 0)
})

test('argv flags missing from the CLI are reported, values are not', () => {
  const supported = parseClaudeSupportedFlags(realHelpExcerpt)
  const unsupported = findUnsupportedClaudeFlags(
    ['-p', '--effort', 'max', '--totally-made-up', 'value', '--add-dir', 'D:/x'],
    supported,
  )

  assert.deepEqual(unsupported, ['--totally-made-up'])
})

test('flag values that look like flags are not reported', () => {
  const supported = parseClaudeSupportedFlags(realHelpExcerpt)
  // `--effort` 的值是 max；一个负数或以 - 开头的值不能被当成参数名去校验。
  const unsupported = findUnsupportedClaudeFlags(
    ['--effort', 'max', '--add-dir', '-weird-looking-value'],
    supported,
  )

  assert.deepEqual(unsupported, [])
})

test('an empty allowlist disables checking entirely', () => {
  // 探测失败时绝不能把每个参数都报成不支持——那会淹没日志且毫无意义。
  assert.deepEqual(findUnsupportedClaudeFlags(['--anything', '--at-all'], new Set()), [])
})

// ---------------------------------------------------------------------------
// 真子进程握手 —— pitfall #283 的教训：纯函数全绿也证明不了这东西真的跑起来过。
// 2026-08-16 第一版实测就栽在这里：单测 6 条全绿，真实探测返回 **0 个参数**，
// 因为它 spawn 了裸命令名而没走 Windows 的 .cmd shim 解析。
// ---------------------------------------------------------------------------

test('the probe really launches a process and parses its real help output', async (t) => {
  t.after(() => resetClaudeCapabilityCacheForTests())
  resetClaudeCapabilityCacheForTests()

  // 拿 node 自己当被测进程：它的 `--help` 就是同一种缩进 + 逗号别名的排版，
  // 而且到处都有。这条断言覆盖的是 **spawn 起来了 → stdout 收到了 → 解析出
  // 了具体参数** 这条完整链路；链路任何一环断掉，size 就是 0，当场变红。
  const flags = await getClaudeSupportedFlags(process.execPath, process.env)

  assert.ok(flags.size > 5, `expected the probe to parse real flags, got ${flags.size}`)
  assert.ok(flags.has('--version'), 'node --help always lists --version')
  assert.ok(flags.has('-v'), 'short aliases on the same line must be collected too')
})

test('the probe is only paid for once per process', async (t) => {
  t.after(() => resetClaudeCapabilityCacheForTests())
  resetClaudeCapabilityCacheForTests()

  // spawn 在这台机器上是主线程同步阻塞、最坏单次 6.9s（pitfall #271），
  // 所以缓存不是优化而是硬约束。
  const first = await getClaudeSupportedFlags(process.execPath, process.env)
  const second = await getClaudeSupportedFlags('definitely-not-a-real-command', process.env)

  assert.equal(second, first, '第二次调用必须直接命中缓存，不能再 spawn 一次')
})

test('a command that cannot launch degrades to an empty set instead of throwing', async (t) => {
  t.after(() => resetClaudeCapabilityCacheForTests())
  resetClaudeCapabilityCacheForTests()

  const dir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-caps-probe-'))
  try {
    // fail-open 是这条链路的核心契约：探测炸了绝不能影响真实回合。
    const flags = await getClaudeSupportedFlags(path.join(dir, 'nope-does-not-exist'), process.env)
    assert.equal(flags.size, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
