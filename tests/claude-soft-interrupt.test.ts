import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  ClaudeSessionPool,
  type ClaudeSessionPoolChild,
  type ClaudeTurnAttachment,
} from '../server/claude-session-pool.ts'
import { tryInterruptProviderTurn } from '../server/providers.ts'

type FakeChild = ClaudeSessionPoolChild & {
  stdoutStream: PassThrough
  stdinChunks: string[]
  killed: boolean
}

const createFakeChild = (options?: { stdinWritable?: boolean; realStdin?: boolean }): FakeChild => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const emitter = new EventEmitter()
  const stdinChunks: string[] = []

  // 默认的 stdin 替身是个纯对象，永远不会 emit 'error' —— 真实的 child.stdin 是
  // 一个 Socket，管道断裂时 EPIPE 只会以异步 'error' 事件的形式出现。用纯对象做
  // 替身等于把这条故障路径从测试里抹掉了，realStdin 用真 stream 才能覆盖到。
  const realStdin = options?.realStdin ? new PassThrough() : null
  realStdin?.on('data', (chunk) => stdinChunks.push(String(chunk)))

  const child = {
    stdout,
    stderr,
    stdin: options?.stdinWritable === false
      ? null
      : (realStdin ?? {
          write: (chunk: string) => {
            stdinChunks.push(chunk)
            return true
          },
          end: () => {},
        }),
    kill: () => {
      if (child.killed) {
        return true
      }
      child.killed = true
      queueMicrotask(() => emitter.emit('close', null))
      return true
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
      return child
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.once(event, listener)
      return child
    },
    stdoutStream: stdout,
    stdinChunks,
    killed: false,
  }

  return child as unknown as FakeChild
}

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const createAttachment = () => {
  const lines: string[] = []
  const closures: Array<number | null> = []
  const attachment: ClaudeTurnAttachment = {
    onLine: (line) => lines.push(line),
    onStderrLine: () => {},
    onProcessClosed: (code) => closures.push(code),
  }
  return { attachment, lines, closures }
}

const acquire = async (pool: ClaudeSessionPool, key: string, child: FakeChild) => {
  const acquired = await pool.acquireForTurn({
    key,
    signature: 'sig',
    sessionId: undefined,
    spawn: async () => child,
  })
  assert.ok(acquired)
  return acquired
}

// 中断收尾行：CLI 在 interrupt 后按序吐 partial assistant → 合成 user 帧 → result。
const ABORTED_RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: 'aborted_streaming',
})

test('interruptTurn 往 stdin 写一行 control_request 且不杀进程', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild()
  await acquire(pool, 'card-interrupt', child)

  const { attachment } = createAttachment()
  pool.beginTurn('card-interrupt', attachment)

  assert.equal(pool.interruptTurn('card-interrupt'), true)
  assert.equal(child.killed, false, '软中断绝不能杀进程——杀了就退化回旧行为')

  assert.equal(child.stdinChunks.length, 1)
  const written = JSON.parse(child.stdinChunks[0] ?? '{}')
  assert.equal(written.type, 'control_request')
  assert.equal(written.request?.subtype, 'interrupt')
  assert.equal(typeof written.request_id, 'string')
  assert.ok((written.request_id as string).length > 0)
  assert.match(child.stdinChunks[0] ?? '', /\n$/, 'stdin 协议是 NDJSON，必须换行结尾')

  pool.dispose()
})

test('中断的收尾输出照常送达 parser，且不唤起幽灵流', async () => {
  let unsolicitedCount = 0
  const pool = new ClaudeSessionPool({
    onUnsolicited: () => {
      unsolicitedCount += 1
    },
  })
  const child = createFakeChild()
  await acquire(pool, 'card-drain', child)

  const { attachment, lines } = createAttachment()
  pool.beginTurn('card-drain', attachment)
  pool.interruptTurn('card-drain')

  child.stdoutStream.write(`${JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })}\n`)
  child.stdoutStream.write(`${ABORTED_RESULT_LINE}\n`)

  await waitFor(() => lines.length >= 2)

  // 这一条是本次改造最容易写错的地方：中断后若把收尾行截掉，provider 的 turn
  // parser 就永远等不到 result，turn 挂起、进程再也不回 idle。收尾必须照常流过去，
  // 由 parser 正常收口；迟到内容归 host 的 terminal 守卫拦截，不在这一层截断。
  assert.equal(lines.length, 2, '收尾行必须完整送达 parser')
  assert.match(lines[1] ?? '', /error_during_execution/)
  assert.equal(unsolicitedCount, 0, '收尾输出走的是 turn 通道，绝不能唤起 unsolicited turn')
  assert.equal(child.killed, false)

  pool.dispose()
})

test('parser 收口后进程留在池里、兜底解除，并能承接下一轮', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {}, interruptDrainTimeoutMs: 60 })
  const child = createFakeChild()
  await acquire(pool, 'card-reuse', child)

  const first = createAttachment()
  pool.beginTurn('card-reuse', first.attachment)
  pool.interruptTurn('card-reuse')
  child.stdoutStream.write(`${ABORTED_RESULT_LINE}\n`)
  await waitFor(() => first.lines.length > 0)

  // provider 的 parser 看到 result 后正常收口。
  pool.endTurn('card-reuse')
  assert.equal(pool.isTurnActive('card-reuse'), false)
  assert.equal(pool.hasEntry('card-reuse'), true, '进程必须留在池里，这正是软中断的意义')

  // 兜底 kill 必须随 endTurn 解除，否则它会在几秒后杀掉一个已经健康的进程。
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(child.killed, false, 'endTurn 之后兜底 kill 必须已解除')
  assert.equal(pool.hasEntry('card-reuse'), true)

  // 中断之后同一个进程要能立刻接下一轮——原生实测三轮两次中断共用一个 session。
  const second = createAttachment()
  assert.equal(pool.beginTurn('card-reuse', second.attachment), true)
  child.stdoutStream.write(`${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '第二轮' }] },
  })}\n`)

  await waitFor(() => second.lines.length > 0)
  assert.match(second.lines[0] ?? '', /第二轮/)

  pool.dispose()
})

test('stdin 不可写时 interruptTurn 返回 false，让调用方走 kill 兜底', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild({ stdinWritable: false })
  await acquire(pool, 'card-nostdin', child)

  const { attachment } = createAttachment()
  pool.beginTurn('card-nostdin', attachment)

  assert.equal(pool.interruptTurn('card-nostdin'), false)
  pool.dispose()
})

test('未知 card 或已收尾的 turn 不会误发中断', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild()
  await acquire(pool, 'card-idle', child)

  // 没有活动 turn 时中断没有意义：发过去只会打断 CLI 自己的后台活儿。
  assert.equal(pool.interruptTurn('card-idle'), false)
  assert.equal(pool.interruptTurn('card-never-existed'), false)
  assert.equal(child.stdinChunks.length, 0)

  pool.dispose()
})

test('收尾输出迟迟不来时超时 kill 兜底，不留半死不活的进程', async () => {
  const pool = new ClaudeSessionPool({
    onUnsolicited: () => {},
    interruptDrainTimeoutMs: 40,
  })
  const child = createFakeChild()
  await acquire(pool, 'card-stuck', child)

  const { attachment } = createAttachment()
  pool.beginTurn('card-stuck', attachment)
  pool.interruptTurn('card-stuck')

  // 用户的心理预期是"点了就停"。CLI 若不吐收尾，必须退回硬 kill，
  // 否则卡片会挂在一个永远不结束的中断态上。
  await waitFor(() => child.killed, 1_000)
  assert.equal(pool.hasEntry('card-stuck'), false)

  pool.dispose()
})

test('软中断可用性可被 expectedChild 校验挡住，避免打断新进程', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild()
  const stranger = createFakeChild()
  await acquire(pool, 'card-guard', child)

  const { attachment } = createAttachment()
  pool.beginTurn('card-guard', attachment)

  assert.equal(pool.interruptTurn('card-guard', stranger), false)
  assert.equal(child.stdinChunks.length, 0)
  assert.equal(pool.interruptTurn('card-guard', child), true)

  pool.dispose()
})

// ---- 管道断裂：EPIPE 绝不能掀掉宿主进程 ----

// 症状：2026-08-10 全天 7 次整窗口闪退，内存充足（空闲 13-16GB、应用仅 470MB），
//   无 crash dump、无 Windows 事件、无退出日志。二分到 8/9 23:28 的包——第一个
//   含软中断的构建——之前的包只在空闲 4-7GB 时才死，是另一类故障。
// 根因：child.stdin 是 Socket，管道断裂时 EPIPE **只以异步 'error' 事件出现**，
//   `stdin.write()` 外面的 try/catch 是空的抓不到；而 wireChild 只接了
//   stdout/stderr/close，stdin 上一个监听器都没有。Node 对无人监听的 stream
//   'error' 会直接 throw，升级成 uncaughtException —— 进程当场消失，
//   连写 dump 的机会都没有，正是"三缺"现场。
// 为什么不能只在调用点补 try/catch：异步 error 根本不经过调用点的栈。唯一有效的
//   位置是建进程时在 stdin 上挂一次监听，一处挂上、所有写入路径全保。
test('池内 stdin 必须挂 error 监听器：EPIPE 不能升级成 uncaughtException', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild({ realStdin: true })
  await acquire(pool, 'card-epipe', child)

  const stdin = child.stdin as unknown as PassThrough
  assert.ok(
    stdin.listenerCount('error') > 0,
    'stdin 上必须有 error 监听器，否则一次 EPIPE 就掀掉整个主进程',
  )

  // 真正的验收：管道断裂时 emit 不得抛出。没有监听器时这一行会直接 throw。
  assert.doesNotThrow(() => {
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  }, '管道断裂必须被吸收，绝不能冒泡成未捕获异常')

  pool.dispose()
})

test('管道断裂后 interruptTurn / writeUserMessage 仍安全，进程不被掀翻', async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild({ realStdin: true })
  await acquire(pool, 'card-epipe-write', child)

  const { attachment } = createAttachment()
  pool.beginTurn('card-epipe-write', attachment)

  // 模拟对端已经消失：destroy 之后任何写入都会异步吐 EPIPE。
  const stdin = child.stdin as unknown as PassThrough
  stdin.destroy()

  assert.doesNotThrow(() => {
    pool.interruptTurn('card-epipe-write')
  }, '对已断管道发中断不得抛出')

  assert.doesNotThrow(() => {
    pool.writeUserMessage('card-epipe-write', JSON.stringify({ type: 'user' }))
  }, '对已断管道发用户消息不得抛出')

  // 给异步 error 事件一个投递窗口——同步不抛不代表安全，EPIPE 是下一个 tick 才来的。
  await new Promise((resolve) => setTimeout(resolve, 30))

  pool.dispose()
})

// ---- 停止路径的选择：软中断优先，绝不静默失败 ----

test('能软中断时 tryInterruptProviderTurn 返回 true，调用方就不该再 kill', () => {
  let calls = 0
  assert.equal(
    tryInterruptProviderTurn({
      interruptTurn: () => {
        calls += 1
        return true
      },
    } as never),
    true,
  )
  assert.equal(calls, 1)
})

test('软中断被拒绝时如实返回 false，让调用方硬 kill 兜底', () => {
  assert.equal(tryInterruptProviderTurn({ interruptTurn: () => false } as never), false)
})

test('不具备控制通道的 provider 一律返回 false，走原有 kill 路径', () => {
  assert.equal(tryInterruptProviderTurn(null), false)
  assert.equal(tryInterruptProviderTurn(undefined), false)
  assert.equal(tryInterruptProviderTurn({} as never), false)
  assert.equal(tryInterruptProviderTurn({ interruptTurn: 'nope' } as never), false)
})

test('软中断抛异常等同于不可用，绝不能把停止请求吞掉', () => {
  // 静默吞掉 = 停止按钮失灵，比退化回 kill 严重得多。
  assert.equal(
    tryInterruptProviderTurn({
      interruptTurn: () => {
        throw new Error('stdin already closed')
      },
    } as never),
    false,
  )
})
