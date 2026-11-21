import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { ClaudeSessionPool, type ClaudeSessionPoolChild } from '../server/claude-session-pool.ts'
import { tryInjectProviderTurnMessage } from '../server/providers.ts'

// 症状（2026-11-20 用户）：流式中发消息会杀掉会话里在跑的子 agent；用户要的是「消息立马发出去，
//   子 agent 别死」。真 CLI 探针 scripts/probe-claude-midturn-message.mjs（2.1.322）证明：
//   回合进行中不打断、直接往 stdin 写 user 帧，CLI 在下一个工具边界把它交给模型、同一轮作答，
//   后台子代理进程全程存活。所以这里只往活动回合里「插话」，绝不发 interrupt。

type FakeChild = ClaudeSessionPoolChild & { stdinChunks: string[]; killed: boolean }

const createFakeChild = (): FakeChild => {
  const emitter = new EventEmitter()
  const stdinChunks: string[] = []
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: { write: (chunk: string) => { stdinChunks.push(chunk); return true }, end: () => {} },
    kill: () => { child.killed = true; queueMicrotask(() => emitter.emit('close', null)); return true },
    on: (event: string, listener: (...args: unknown[]) => void) => { emitter.on(event, listener); return child },
    once: (event: string, listener: (...args: unknown[]) => void) => { emitter.once(event, listener); return child },
    stdinChunks,
    killed: false,
  }
  return child as unknown as FakeChild
}

const attachment = { onLine: () => {}, onStderrLine: () => {}, onProcessClosed: () => {} }

const setup = async () => {
  const pool = new ClaudeSessionPool({ onUnsolicited: () => {} })
  const child = createFakeChild()
  const acquired = await pool.acquireForTurn({ key: 'card', signature: 'sig', sessionId: undefined, spawn: async () => child })
  assert.ok(acquired)
  return { pool, child }
}

const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })

test('injectUserMessage writes a user frame into the active turn without interrupting', async () => {
  const { pool, child } = await setup()
  pool.beginTurn('card', attachment, child)
  const serial = pool.getTurnSerial('card', child)!

  assert.equal(pool.injectUserMessage('card', userLine, child, serial), true)
  assert.equal(child.stdinChunks.length, 1)
  assert.equal(JSON.parse(child.stdinChunks[0]!).type, 'user')
  assert.doesNotMatch(child.stdinChunks.join(''), /control_request/)
  assert.equal(child.killed, false)
  pool.dispose()
})

test('injectUserMessage refuses idle processes, stale turns and interrupted turns', async () => {
  const { pool, child } = await setup()
  // 没有活动回合：插进去会被 CLI 当成新回合跑，而渲染端已不在监听。
  assert.equal(pool.injectUserMessage('card', userLine, child, 0), false)

  pool.beginTurn('card', attachment, child)
  const serial = pool.getTurnSerial('card', child)!
  assert.equal(pool.injectUserMessage('card', userLine, child, serial - 1), false, 'stale turn serial')

  pool.interruptTurn('card', child, serial)
  const before = child.stdinChunks.length
  assert.equal(pool.injectUserMessage('card', userLine, child, serial), false, 'turn already interrupted')
  assert.equal(child.stdinChunks.length, before)
  pool.dispose()
})

test('tryInjectProviderTurnMessage reports false when the child has no inject channel', async () => {
  assert.equal(await tryInjectProviderTurnMessage(null, { prompt: 'x', attachments: [] }), false)
  assert.equal(await tryInjectProviderTurnMessage({} as never, { prompt: 'x', attachments: [] }), false)
  const child = { injectUserMessage: async () => true }
  assert.equal(await tryInjectProviderTurnMessage(child as never, { prompt: 'x', attachments: [] }), true)
  const throwing = { injectUserMessage: async () => { throw new Error('boom') } }
  assert.equal(await tryInjectProviderTurnMessage(throwing as never, { prompt: 'x', attachments: [] }), false)
})
