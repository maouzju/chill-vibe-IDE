import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatMessage } from '../shared/schema.ts'
import { buildRenderableMessages } from '../src/components/chat-card-parsing.ts'

// 卡死族根因回归测试（stuck-pane goal）：streaming 期间每个 delta 都会让
// buildRenderableMessages 对全部历史消息重跑协议残渣清洗（全文按行 split +
// 逐行正则 × 多遍）。历史消息内容不变，这些纯函数结果必须被缓存复用，
// 否则 5 pane × 多 streaming 时主线程过载积压，表现为 IME 失灵直至
// BrowserWindow unresponsive 永不恢复。真实数据实测：80 万字符会话单次
// 重算 190~470ms，一条长回复流完累计 19s（×5 pane ≈ 96s）。

const makeToolMessage = (id: number): ChatMessage => ({
  id: `tool-${id}`,
  role: 'assistant',
  content: '',
  createdAt: new Date(0).toISOString(),
  meta: {
    provider: 'claude',
    kind: 'tool',
    structuredData: JSON.stringify({
      itemId: `call-${id}`,
      kind: 'tool',
      status: 'completed',
      title: `Read file ${id}`,
    }),
  },
} as unknown as ChatMessage)

const makeAssistantMessage = (id: number, content: string): ChatMessage => ({
  id: `assistant-${id}`,
  role: 'assistant',
  content,
  createdAt: new Date(0).toISOString(),
  meta: { provider: 'claude' },
} as unknown as ChatMessage)

const paragraph =
  '这是一段普通的助手回复文本，描述实现方案与设计取舍，不含任何残渣词。\n' +
  'The assistant explains the layout system and rendering pipeline in detail.\n' +
  '代码围栏外的普通行，逐行清洗时每行都要跑 marker 判定。\n'

const buildHistory = (bigChars: number): ChatMessage[] => {
  const messages: ChatMessage[] = []
  const big = paragraph.repeat(Math.ceil(bigChars / paragraph.length))
  for (let i = 0; i < 60; i += 1) {
    messages.push(makeToolMessage(i))
    messages.push(makeAssistantMessage(i, paragraph.repeat(20)))
    // 每 15 组塞一条长回复，接近真实"用久了"的会话形态（数条数十万字符消息）
    if (i % 15 === 7) messages.push(makeAssistantMessage(1000 + i, big))
  }
  return messages
}

test('buildRenderableMessages reuses sanitize results across streaming deltas (stuck-pane regression)', () => {
  const history = buildHistory(200_000)
  const tail = paragraph.repeat(30)

  // 预热一次，排除首次 JIT/正则编译噪音
  buildRenderableMessages([...history, makeAssistantMessage(9999, tail.slice(0, 100))])

  const deltas = 40
  const started = performance.now()
  for (let step = 1; step <= deltas; step += 1) {
    const cut = Math.floor((tail.length * step) / deltas)
    // 浅拷贝模拟 reducer 每 delta 产出的新消息对象（缓存必须按内容而非对象命中）
    const messages = [...history.map((m) => ({ ...m })), makeAssistantMessage(9999, tail.slice(0, cut))]
    const rendered = buildRenderableMessages(messages)
    assert.ok(rendered.length > 40, 'sanity: renderable output present')
  }
  const elapsed = performance.now() - started

  // 无缓存时该场景实测秒级（>1600ms）；内容级缓存命中后应缩到远低于此。
  // 阈值给足慢机余量，仍能稳定区分红/绿。
  assert.ok(
    elapsed < 900,
    `40 deltas over a large history took ${Math.round(elapsed)}ms; ` +
      'per-delta full re-sanitize of unchanged history messages has regressed',
  )
})

test('long-form assistant prose is never classified as retry chatter even when it mentions tooling keywords', () => {
  // retry chatter 是模型道歉+重发的短碎片；长正文即便含"工具/重试/tool/format"
  // 字样也必须保留（既是行为保护，也让流式尾消息的每 delta 谓词成本有上限）。
  const longProse =
    '这篇长文档讨论了工具链的设计，其中提到当解析失败时应当重试请求。\n' +
    'The design retries the tool call pipeline when the format is malformed.\n' +
    paragraph.repeat(200)
  const messages: ChatMessage[] = [
    makeToolMessage(1),
    makeAssistantMessage(1, longProse),
    makeToolMessage(2),
  ]
  const rendered = buildRenderableMessages(messages)
  const hasProse = rendered.some(
    (item) => item.type === 'message' && item.message.content.includes('这篇长文档'),
  )
  assert.ok(hasProse, 'long prose mentioning tooling keywords must stay visible')
})
