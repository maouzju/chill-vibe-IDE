import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'

import { ChatManager, type StreamEnvelope } from '../server/chat-manager.ts'
import {
  ClaudeSessionPool,
  type ClaudeSessionPoolChild,
  type ClaudeTurnAttachment,
} from '../server/claude-session-pool.ts'
import type { ChatRequest } from '../shared/schema.ts'

const waitFor = async (predicate: () => boolean, message: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, message)
}

const buildRequest = (streamId: string, workspacePath: string): ChatRequest => ({
  streamId,
  provider: 'claude',
  prompt: 'test',
  workspacePath,
  attachments: [],
  model: 'claude-opus-4-7',
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  language: 'zh-CN',
  systemPrompt: '',
  modelPromptRules: [],
  crossProviderSkillReuseEnabled: true,
})

const setup = async (
  t: TestContext,
  child: ChildProcess,
) => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-soft-interrupt-'))
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })
  let launched = false
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => ({ files: [] }),
    providerLauncher: async () => {
      launched = true
      return child
    },
  })
  t.after(() => manager.closeAll())
  const events: StreamEnvelope[] = []
  return {
    manager,
    events,
    start: async (streamId: string) => {
      manager.createStream(buildRequest(streamId, workspacePath))
      manager.subscribe(streamId, (payload) => {
        events.push(payload)
      })
      await waitFor(() => launched, 'provider child should launch')
      // stream.child 在 launcher resolve 之后的下一个 microtask 才挂上。
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
  }
}

// 症状：左键发送打断 Claude 后，渲染端按硬杀年代的 pitfall #118 清掉 sessionId，
//   下一条消息以 seeded 摘要冷启动、常驻进程被杀。
// 根因：stop() 早已优先走 control_request 软中断（进程、会话、上下文全存活），
//   但终态信封里从没告诉渲染端"这次是软中断"，它只能一律按最坏情况处理。
// 这里钉住：软中断成功必须写进 done 信封；硬杀回退必须如实报 false。
test('stop marks the terminal done envelope as a soft interrupt and keeps the child alive', async (t) => {
  let killed = false
  let interrupts = 0
  const child = {
    kill: () => {
      killed = true
      return true
    },
    interruptTurn: () => {
      interrupts += 1
      return true
    },
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('soft-interrupt-stream')

  const result = manager.stop('soft-interrupt-stream')

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, true, 'stop result must report the soft interrupt')
  assert.equal(interrupts, 1)
  assert.equal(killed, false, 'a soft interrupt must not kill the pooled child')

  const done = events.find((item) => item.event === 'done')
  assert.ok(done, 'stop must still emit the terminal done envelope')
  assert.deepEqual(done.data, { stopped: true, interrupted: true })
})

test('stop reports interrupted=false when the child only supports a hard kill', async (t) => {
  let killed = false
  const child = {
    kill: () => {
      killed = true
      return true
    },
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('hard-kill-stream')

  const result = manager.stop('hard-kill-stream')

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, false)
  assert.equal(killed, true, 'without an interrupt channel stop must fall back to kill')

  const done = events.find((item) => item.event === 'done')
  assert.ok(done)
  assert.deepEqual(done.data, { stopped: true, interrupted: false })
})

test('stop reports interrupted=false when the interrupt channel refuses the request', async (t) => {
  let killed = false
  const child = {
    kill: () => {
      killed = true
      return true
    },
    interruptTurn: () => false,
  } as unknown as ChildProcess
  const { manager, events, start } = await setup(t, child)
  await start('refused-interrupt-stream')

  const result = manager.stop('refused-interrupt-stream')

  assert.equal(result.interrupted, false)
  assert.equal(killed, true, 'a refused soft interrupt must fall back to kill')
  const done = events.find((item) => item.event === 'done')
  assert.ok(done)
  assert.deepEqual(done.data, { stopped: true, interrupted: false })
})

test('软中断结果在 workspace diff 延迟收尾时仍随 done 发出', async (t) => {
  let releaseDiff!: () => void
  const gate = new Promise<void>((resolve) => { releaseDiff = resolve })
  let diffStarted = false
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => {
      diffStarted = true
      await gate
      return { files: [] }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return { kill: () => true, interruptTurn: () => true } as unknown as ChildProcess
    },
  })
  t.after(() => { releaseDiff(); manager.closeAll() })
  const events: StreamEnvelope[] = []
  manager.createStream(buildRequest('deferred', '.'))
  manager.subscribe('deferred', (event) => events.push(event))
  await waitFor(() => diffStarted, '等待收尾 diff')
  const result = manager.stop('deferred')
  assert.equal(result.interrupted, true)
  assert.ok(result.settlingWithinMs > 0)
  assert.equal(events.some((item) => item.event === 'done'), false)
  releaseDiff()
  await waitFor(() => events.some((item) => item.event === 'done'), '等待 done')
  assert.deepEqual(events.find((item) => item.event === 'done')?.data, { stopped: true, interrupted: true })
})

// ---- 重复 stop：第一次已经决定了这一轮怎么停，后面的不能改写它 ----

// 症状：软中断成功后追问仍冷启动（seeded），常驻进程与上下文被丢。
// 根因：收尾 diff 挂着的窗口里（最长 12s）流仍是非终态，第二次 stop 会重跑一遍
//   「软中断 → 硬杀」。此时 managed handle 早已随 onSettled 撤掉了控制通道，
//   tryInterruptProviderTurn 返回 false，softInterrupted 被覆写成 false，
//   终态 done 信封就变成 interrupted:false，渲染端按硬杀年代的 #118 清掉 sessionId。
// 为什么不能只在渲染端去重：stop 桥（HTTP / IPC）两条都是纯透传，重复 stop 可以来自
//   渲染兜底、手机监工、用户连点，服务端必须自己幂等。
test('重复 stop 收尾中的流：只中断一次，且不改写第一次的软中断结果', async (t) => {
  let releaseDiff!: () => void
  const gate = new Promise<void>((resolve) => { releaseDiff = resolve })
  let diffStarted = false
  let interrupts = 0
  let kills = 0
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => {
      diffStarted = true
      await gate
      return { files: [] }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return {
        // 真实 handle 的行为：第一次能中断，settle 之后控制通道已撤掉，再来就是 false。
        kill: () => {
          kills += 1
          return true
        },
        interruptTurn: () => {
          interrupts += 1
          return interrupts === 1
        },
      } as unknown as ChildProcess
    },
  })
  t.after(() => { releaseDiff(); manager.closeAll() })
  const events: StreamEnvelope[] = []
  manager.createStream(buildRequest('deferred-repeat', '.'))
  manager.subscribe('deferred-repeat', (event) => events.push(event))
  await waitFor(() => diffStarted, '等待收尾 diff')
  // stream.child 在 launcher resolve 之后的下一个 microtask 才挂上。
  await new Promise((resolve) => setTimeout(resolve, 30))

  const first = manager.stop('deferred-repeat')
  const second = manager.stop('deferred-repeat')
  const third = manager.stop('deferred-repeat')

  assert.equal(first.interrupted, true)
  assert.equal(second.interrupted, true, '重复 stop 必须回报第一次的结果')
  assert.equal(third.interrupted, true)
  assert.ok(second.settlingWithinMs > 0, '终态仍在等收尾 diff，契约不变')
  assert.equal(interrupts, 1, '控制通道只该被写一次')
  assert.equal(kills, 0, '软中断成功之后绝不能再补一刀 kill')

  releaseDiff()
  await waitFor(() => events.some((item) => item.event === 'done'), '等待 done')
  assert.deepEqual(events.find((item) => item.event === 'done')?.data, { stopped: true, interrupted: true })
})

test('重复 stop 硬杀兜底的流：只 kill 一次', async (t) => {
  let releaseDiff!: () => void
  const gate = new Promise<void>((resolve) => { releaseDiff = resolve })
  let diffStarted = false
  let kills = 0
  const manager = new ChatManager({
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => {
      diffStarted = true
      await gate
      return { files: [] }
    },
    providerLauncher: async (_request, sink) => {
      sink.onDone({})
      return {
        kill: () => {
          kills += 1
          return true
        },
      } as unknown as ChildProcess
    },
  })
  t.after(() => { releaseDiff(); manager.closeAll() })
  const events: StreamEnvelope[] = []
  manager.createStream(buildRequest('deferred-repeat-kill', '.'))
  manager.subscribe('deferred-repeat-kill', (event) => events.push(event))
  await waitFor(() => diffStarted, '等待收尾 diff')
  await new Promise((resolve) => setTimeout(resolve, 30))

  manager.stop('deferred-repeat-kill')
  manager.stop('deferred-repeat-kill')

  assert.equal(kills, 1)
  releaseDiff()
  await waitFor(() => events.some((item) => item.event === 'done'), '等待 done')
  assert.deepEqual(events.find((item) => item.event === 'done')?.data, { stopped: true, interrupted: false })
})

// ---- 自发轮次的 stop 必须绑定「那一轮」，不能是进程作用域的 ----

const UNSOLICITED_KEY = 'card-unsolicited-stop'

const noopAttachment = (): ClaudeTurnAttachment => ({
  onLine: () => {},
  onStderrLine: () => {},
  onProcessClosed: () => {},
})

// 拉起一个「CLI 自己醒来的那一轮」：常驻进程空闲时吐出 message_start，pool 唤起
// unsolicited 流并回调宿主。返回时该轮仍是 turn-active。
const setupUnsolicitedTurn = async (t: TestContext, options: { stdinBroken?: boolean } = {}) => {
  const notifications: Array<{ cardId: string; streamId: string }> = []
  let releaseDiff!: () => void
  const gate = new Promise<void>((resolve) => { releaseDiff = resolve })
  let diffStarted = false
  const manager = new ChatManager({
    enableClaudeKeepalive: true,
    onUnsolicitedStream: (notification) => notifications.push(notification),
    workspaceSnapshotter: async () => null,
    workspaceDiffer: async () => {
      diffStarted = true
      await gate
      return { files: [] }
    },
  })
  t.after(async () => {
    // 先放行 diff 让收尾走完再 closeAll：反过来的话 finalize 会在 streams 清空之后
    // 给一条已脱管的流挂 5 分钟清理定时器，测试进程就退不出去。
    releaseDiff()
    await new Promise((resolve) => setTimeout(resolve, 30))
    manager.closeAll()
  })
  const pool = (manager as unknown as { claudePool: ClaudeSessionPool }).claudePool
  const stdout = new PassThrough()
  const emitter = new EventEmitter()
  const stdinChunks: string[] = []
  let killed = false
  const child: ClaudeSessionPoolChild = {
    stdout,
    stderr: new PassThrough(),
    stdin: {
      write: (chunk: string) => {
        if (options.stdinBroken) {
          throw new Error('write EPIPE')
        }
        stdinChunks.push(chunk)
        return true
      },
      end: () => {},
    },
    kill: () => {
      killed = true
      queueMicrotask(() => emitter.emit('close', null))
      return true
    },
    on: (event, listener) => { emitter.on(event, listener); return emitter },
    once: (event, listener) => { emitter.once(event, listener); return emitter },
  }
  await pool.acquireForTurn({
    key: UNSOLICITED_KEY,
    signature: 'sig',
    sessionId: 'session-unsolicited',
    meta: { language: 'zh-CN', workspacePath: '.' },
    spawn: async () => child,
  })
  stdout.write('{"type":"stream_event","event":{"type":"message_start"}}\n')
  await waitFor(() => notifications.length > 0, '等待自发轮次挂载')

  return {
    manager,
    pool,
    child,
    stdinChunks,
    isKilled: () => killed,
    streamId: notifications[0]!.streamId,
    // 自发轮次的 result：parser 先 onDone（挂起收尾 diff），再 onSettled（池里回 idle）。
    finishTurn: async () => {
      stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"done"}\n')
      await waitFor(() => diffStarted, '等待自发轮次的收尾 diff 挂起')
      assert.equal(pool.isTurnActive(UNSOLICITED_KEY), false, 'result 之后进程应回到 idle')
    },
  }
}

// 症状：点「继续」后 0.5~4.6 秒又被停下，得再点一次（16 天 48 例）。
// 根因（自发轮次这一路）：stopHook 只认 key + child、不认轮次。后台任务唤醒的那一轮已经
//   收尾、stream 还挂在收尾 diff 上时，用户在同一张卡上发的下一轮已经复用了同一个常驻进程；
//   这条迟到的 stop 把 interrupt 写进了下一轮（进程忙），或者在进程空闲时把健康进程直接杀掉。
// 为什么不能只在 stream 层判终态：这条 stream 此刻确实还没终态（在等 diff），挡不住。
test('已收尾的自发轮次迟到的 stop 不得打断同一进程里的下一轮', async (t) => {
  const h = await setupUnsolicitedTurn(t)
  await h.finishTurn()

  // 用户在同一张卡上发出的下一轮，复用这个常驻进程。
  assert.equal(h.pool.beginTurn(UNSOLICITED_KEY, noopAttachment(), h.child), true)
  assert.equal(h.pool.isTurnActive(UNSOLICITED_KEY), true)

  const result = h.manager.stop(h.streamId)

  assert.equal(h.stdinChunks.length, 0, '迟到的 stop 不能把 interrupt 写进下一轮')
  assert.equal(h.isKilled(), false, '也不能把正在跑下一轮的进程杀掉')
  assert.equal(h.pool.hasEntry(UNSOLICITED_KEY), true)
  assert.equal(h.pool.isTurnActive(UNSOLICITED_KEY), true, '下一轮必须原样继续')
  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, true, '进程与会话原样保留，渲染端不该因此清 sessionId')
})

test('已收尾的自发轮次迟到的 stop 不得把空闲的健康进程杀掉', async (t) => {
  const h = await setupUnsolicitedTurn(t)
  await h.finishTurn()

  const result = h.manager.stop(h.streamId)

  assert.equal(h.isKilled(), false, '轮次已经结束，没有东西可停，杀进程只会丢后台任务和会话')
  assert.equal(h.pool.hasEntry(UNSOLICITED_KEY), true)
  assert.equal(h.stdinChunks.length, 0)
  assert.equal(result.interrupted, true, '没杀进程，会话完好，回报 true 才不会让渲染端白白冷启动')
})

test('进行中的自发轮次：stop 走软中断，只写一行 interrupt 且不杀进程', async (t) => {
  const h = await setupUnsolicitedTurn(t)
  assert.equal(h.pool.isTurnActive(UNSOLICITED_KEY), true)

  const result = h.manager.stop(h.streamId)

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, true)
  assert.equal(h.stdinChunks.length, 1)
  assert.equal(JSON.parse(h.stdinChunks[0] ?? '{}').request?.subtype, 'interrupt')
  assert.equal(h.isKilled(), false)
})

test('进行中的自发轮次：控制通道写不进去时仍退回硬杀兜底', async (t) => {
  const h = await setupUnsolicitedTurn(t, { stdinBroken: true })
  assert.equal(h.pool.isTurnActive(UNSOLICITED_KEY), true)

  const result = h.manager.stop(h.streamId)

  assert.equal(result.stopped, true)
  assert.equal(result.interrupted, false)
  assert.equal(h.isKilled(), true, '当前轮的控制通道真坏了，硬杀兜底必须保留')
})
