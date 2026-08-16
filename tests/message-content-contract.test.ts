import assert from 'node:assert/strict'
import test from 'node:test'

import { getChatMessageAttachments, attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import { chatMessageSchema } from '../shared/schema.ts'

// 2026-08-16 拿 ACP v1 的 ContentBlock 对照本仓库的 ChatMessage 时，原始判断是
// 「消息只有 content:string，附件根本不落到消息上」。**核实后前提不成立**：
// 附件确实落在消息上，以 meta.imageAttachments 的 JSON 字符串形式
// （shared/chat-attachments.ts）。
//
// 于是这条的真实约束不是"没有内容块"，而是**meta 是 Record<string,string>**：
// 结构化内容一律要自己序列化，而 state-store 的 normalizeStringRecord 会把任何
// 非 string 的 meta 值**静默丢弃**。这个契约此前只存在于 zod 定义里，没有一条
// 测试钉住它，也没有任何地方写明"塞非字符串会悄悄丢数据"。

test('message meta only accepts string values', () => {
  // 这是整个结构化内容方案的地基：谁往 meta 里塞了数字/对象/布尔，
  // 存盘再读回来就没了（normalizeStringRecord 按 typeof 过滤），而且不报错。
  assert.equal(
    chatMessageSchema.safeParse({
      id: 'm1',
      role: 'user',
      content: 'hi',
      createdAt: new Date().toISOString(),
      meta: { tokens: 42 },
    }).success,
    false,
    'meta 只能是 string→string；放宽它会让持久化层静默丢数据',
  )

  assert.equal(
    chatMessageSchema.safeParse({
      id: 'm1',
      role: 'user',
      content: 'hi',
      createdAt: new Date().toISOString(),
      meta: { tokens: '42' },
    }).success,
    true,
  )
})

test('image attachments really do live on the message, serialized into meta', () => {
  // 证伪"附件不落到消息上"的那条判断：它们在，只是以 JSON 字符串的形态。
  const meta = attachImagesToMessageMeta([
    { id: 'att-1', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 10 },
  ])

  assert.equal(typeof meta?.imageAttachments, 'string')
  const recovered = getChatMessageAttachments({ meta })
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0]?.id, 'att-1')
})

test('a corrupted attachment payload degrades to empty instead of throwing', () => {
  // 既有的容错行为，钉住它：坏 JSON 不能让整条转录渲染失败。
  assert.deepEqual(getChatMessageAttachments({ meta: { imageAttachments: '{not json' } }), [])
  assert.deepEqual(getChatMessageAttachments({ meta: { imageAttachments: '"a string"' } }), [])
  assert.deepEqual(getChatMessageAttachments({ meta: {} }), [])
})

test('attaching no images leaves the meta object untouched', () => {
  // 引用相等：上层按引用做记忆化，凭空新建对象会白白打断它。
  const original = { kind: 'log' }
  assert.equal(attachImagesToMessageMeta([], original), original)
})
