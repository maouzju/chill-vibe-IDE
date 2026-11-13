import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDefaultSettings,
  createDefaultState,
  createMessage,
  normalizeAppSettings,
} from '../shared/default-state.ts'
import { appSettingsSchema, type ChatMessage } from '../shared/schema.ts'
import { ideReducer } from '../src/state.ts'
import {
  getPendingCompactBoundaryMessage,
  isCompactBoundaryMessage,
  isHiddenCompactBoundaryMessage,
  markAppAutoCompactRun,
  markCompactBoundaryMessage,
  settlePendingCompactBoundary,
} from '../src/components/chat-card-compaction.ts'
import {
  attachContextUsageMeta,
  describeContextUsage,
  formatTokenCount,
  getContextUsageLevel,
  getContextUsagePercent,
  markAutoCompactNotCompleted,
  readPersistedContextUsage,
  reduceContextUsage,
  settleRunEndMessages,
  shouldAutoCompactBeforeSend,
  summarizeAutoCompactFailureDetail,
  type AutoCompactDecisionInput,
} from '../src/components/context-usage.ts'
import {
  applyContextUsageEvent,
  clearContextUsage,
  forgetContextUsage,
  getContextUsageSnapshot,
  hasContextCompactedDuringRun,
  resetContextUsageStoreForTests,
  resolveContextUsage,
  seedContextUsage,
  settleRunEndForCard,
  subscribeContextUsage,
} from '../src/components/context-usage-store.ts'

// ---------------------------------------------------------------------------
// 事件 → 快照
// ---------------------------------------------------------------------------

test('occupancy and window arrive separately and are merged into one snapshot', () => {
  // Claude 的占用在请求开始时就有，窗口要等 result 才报。
  const afterStart = reduceContextUsage(undefined, { used: 44289 })
  assert.deepEqual(afterStart, { used: 44289 })

  const afterResult = reduceContextUsage(afterStart, { used: 44377, size: 200000 })
  assert.deepEqual(afterResult, { used: 44377, size: 200000 })

  // 下一回合的请求事件不带窗口：窗口沿用上一回合的。
  assert.deepEqual(reduceContextUsage(afterResult, { used: 46000 }), { used: 46000, size: 200000 })
})

test('a compaction makes occupancy unknown until the next real request', () => {
  const full = reduceContextUsage(undefined, { used: 181234, size: 200000 })
  const compacted = reduceContextUsage(full, { reset: true })

  // 不拿任何估算值冒充：used 直接没有。窗口不受压缩影响。
  assert.equal(compacted.used, undefined)
  assert.equal(compacted.size, 200000)

  const next = reduceContextUsage(compacted, { used: 45261 })
  assert.equal(next.used, 45261)
  // 压缩后第一次真实占用记成基线，用来判断后面「有没有明显长回来」。
  assert.equal(next.baselineUsed, 45261)

  const later = reduceContextUsage(next, { used: 90000 })
  assert.equal(later.used, 90000)
  assert.equal(later.baselineUsed, 45261)
})

test('a merged backlog entry carrying both reset and occupancy is applied in that order', () => {
  const full = reduceContextUsage(undefined, { used: 181234, size: 200000 })
  const replayed = reduceContextUsage(full, { reset: true, used: 45261, size: 200000 })

  assert.equal(replayed.used, 45261)
  assert.equal(replayed.baselineUsed, 45261)
  assert.equal(replayed.size, 200000)
})

test('nonsense numbers from a provider never reach the snapshot', () => {
  const base = reduceContextUsage(undefined, { used: 1000, size: 200000 })

  assert.equal(reduceContextUsage(base, { used: -5 }), base)
  assert.equal(reduceContextUsage(base, { used: Number.NaN }), base)
  assert.equal(reduceContextUsage(base, { size: 0 }), base)
  // 没变化就返回同一个对象：订阅它的组件不会白白重渲染。
  assert.equal(reduceContextUsage(base, { used: 1000 }), base)
})

// ---------------------------------------------------------------------------
// 展示
// ---------------------------------------------------------------------------

test('percentage needs both occupancy and a window reported by the CLI', () => {
  assert.equal(getContextUsagePercent({ used: 100000, size: 200000 }), 50)
  // 不知道窗口就没有百分比（pitfall #293：不维护模型窗口表去猜）。
  assert.equal(getContextUsagePercent({ used: 100000 }), undefined)
  assert.equal(getContextUsagePercent({ size: 200000 }), undefined)
  assert.equal(getContextUsagePercent(undefined), undefined)
  // 窗口报小了也不画出超过一圈的环。
  assert.equal(getContextUsagePercent({ used: 250000, size: 200000 }), 100)
})

test('the indicator level follows the configured auto-compact threshold', () => {
  assert.equal(getContextUsageLevel(50, 80), 'normal')
  assert.equal(getContextUsageLevel(69.9, 80), 'normal')
  // 阈值的 7/8 开始提醒：80% 阈值下是 70%。
  assert.equal(getContextUsageLevel(70, 80), 'warning')
  assert.equal(getContextUsageLevel(79.9, 80), 'warning')
  assert.equal(getContextUsageLevel(80, 80), 'danger')
  assert.equal(getContextUsageLevel(undefined, 80), 'normal')
})

test('token counts are shortened the way people read them', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(1000), '1k')
  assert.equal(formatTokenCount(44289), '44.3k')
  assert.equal(formatTokenCount(200000), '200k')
  assert.equal(formatTokenCount(1000000), '1M')
  assert.equal(formatTokenCount(1048576), '1.05M')
})

test('the indicator shows a percentage when the window is known and a token count otherwise', () => {
  const known = describeContextUsage({
    snapshot: { used: 44377, size: 200000 },
    language: 'zh-CN',
    autoCompactEnabled: false,
    autoCompactThresholdPercent: 80,
  })
  assert.equal(known?.valueLabel, '22%')
  assert.equal(known?.percent, 22.1885)
  assert.equal(known?.level, 'normal')
  assert.equal(known?.summary, '上下文已用 44.4k / 200k（22%）')
  // 自动压缩关着：悬停提示里不提它。
  assert.equal(known?.tooltip, known?.summary)

  const unknownWindow = describeContextUsage({
    snapshot: { used: 44289 },
    language: 'zh-CN',
    autoCompactEnabled: true,
    autoCompactThresholdPercent: 80,
  })
  assert.equal(unknownWindow?.valueLabel, '44.3k')
  assert.equal(unknownWindow?.percent, undefined)
  assert.equal(unknownWindow?.summary, '上下文已用 44.3k')
  // 不知道窗口就不知道什么时候会压：不提。
  assert.equal(unknownWindow?.tooltip, unknownWindow?.summary)

  // 没有占用就什么都不显示。
  assert.equal(
    describeContextUsage({
      snapshot: { size: 200000 },
      language: 'zh-CN',
      autoCompactEnabled: true,
      autoCompactThresholdPercent: 80,
    }),
    undefined,
  )
  assert.equal(
    describeContextUsage({
      snapshot: undefined,
      language: 'zh-CN',
      autoCompactEnabled: true,
      autoCompactThresholdPercent: 80,
    }),
    undefined,
  )
})

test('the shown percentage never reaches the threshold before the real occupancy does', () => {
  // 79.6% 显示 79% 而不是 80%：数字一到阈值，下一次发送就真的会先压缩，不能提前喊。
  const almost = describeContextUsage({
    snapshot: { used: 159200, size: 200000 },
    language: 'zh-CN',
    autoCompactEnabled: true,
    autoCompactThresholdPercent: 80,
  })
  assert.equal(almost?.valueLabel, '79%')
  assert.equal(almost?.level, 'warning')
  assert.equal(
    almost?.tooltip,
    '上下文已用 159.2k / 200k（79%）。到 80% 时，下一条消息发出前会先自动压缩。',
  )

  const reached = describeContextUsage({
    snapshot: { used: 160000, size: 200000 },
    language: 'zh-CN',
    autoCompactEnabled: true,
    autoCompactThresholdPercent: 80,
  })
  assert.equal(reached?.valueLabel, '80%')
  assert.equal(reached?.level, 'danger')
})

test('without a configured threshold the indicator stays neutral', () => {
  const display = describeContextUsage({
    snapshot: { used: 190000, size: 200000 },
    language: 'en',
    autoCompactEnabled: true,
    autoCompactThresholdPercent: undefined,
  })
  assert.equal(display?.level, 'normal')
  assert.equal(display?.summary, 'Context used: 190k / 200k (95%)')
  assert.equal(display?.tooltip, display?.summary)
})

// ---------------------------------------------------------------------------
// 落盘 / 重启恢复
// ---------------------------------------------------------------------------

const durationMessage = (id: string): ChatMessage => ({
  id,
  role: 'system',
  content: '耗时 12 秒',
  createdAt: '2026-11-12T08:00:00.000Z',
  meta: { kind: 'run-duration' },
})

test('occupancy round-trips through the run-duration message meta', () => {
  const persisted = attachContextUsageMeta(
    durationMessage('d-1'),
    { used: 44377, size: 200000, baselineUsed: 30000 },
    'claude',
  )

  // 每个数值各占一个键（meta 是 Record<string, string>，pitfall #180：不 JSON.stringify 成一个键）。
  assert.equal(persisted.meta?.contextUsageUsed, '44377')
  assert.equal(persisted.meta?.contextUsageSize, '200000')
  assert.equal(persisted.meta?.contextUsageBaseline, '30000')
  // 原有的 meta 不能丢。
  assert.equal(persisted.meta?.kind, 'run-duration')

  assert.deepEqual(readPersistedContextUsage([persisted], 'claude'), {
    used: 44377,
    size: 200000,
    baselineUsed: 30000,
  })
})

test('a snapshot with nothing known leaves the message untouched', () => {
  const message = durationMessage('d-1')
  assert.equal(attachContextUsageMeta(message, undefined, 'claude'), message)
  assert.equal(attachContextUsageMeta(message, {}, 'claude'), message)
})

test('restoring after a restart takes the most recent recorded occupancy', () => {
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 40000, size: 200000 }, 'claude'),
    createMessage('user', '继续'),
    createMessage('assistant', '好的'),
    attachContextUsageMeta(durationMessage('d-2'), { used: 52000, size: 200000 }, 'claude'),
  ]

  assert.deepEqual(readPersistedContextUsage(messages, 'claude'), { used: 52000, size: 200000 })
  assert.equal(readPersistedContextUsage([createMessage('user', 'hi')], 'claude'), undefined)
  assert.equal(readPersistedContextUsage([], 'claude'), undefined)
})

test('occupancy recorded before a compaction is not restored as current', () => {
  // 压缩回合没留下自己的占用记录时：压缩前那条 170k 不能在重启后复活，
  // 否则指示器显示快满、下一次发送又白压一遍。窗口大小仍然可用；
  // 「等基线」也要带回来，压缩后的第一次真实占用才会被记成基线。
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    markCompactBoundaryMessage(createMessage('user', '/compact')),
  ]

  assert.deepEqual(readPersistedContextUsage(messages, 'claude'), {
    size: 200000,
    awaitingBaseline: true,
  })
})

test('the compaction turn own record survives a restart, including the pending baseline', () => {
  // 压缩回合结束时 store 里只有窗口（占用已被 reset 清掉），外加「等基线」。
  const compactionTurn = reduceContextUsage(
    reduceContextUsage({ used: 170000, size: 200000 }, { reset: true }),
    { size: 200000 },
  )
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    markCompactBoundaryMessage(createMessage('user', '/compact')),
    attachContextUsageMeta(durationMessage('d-2'), compactionTurn, 'claude'),
  ]

  const restored = readPersistedContextUsage(messages, 'claude')
  assert.deepEqual(restored, { size: 200000, awaitingBaseline: true })

  // 重启后的第一次真实占用照样被记成基线。
  assert.deepEqual(reduceContextUsage(restored, { used: 45261 }), {
    used: 45261,
    size: 200000,
    baselineUsed: 45261,
  })
})

test('a record left by another provider is not restored', () => {
  // 卡片从 Claude 换到 Codex 且保留了历史：Claude 会话的 150k / 200k 和 Codex 的新会话无关。
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 150000, size: 200000 }, 'claude'),
    createMessage('user', '继续'),
  ]

  assert.equal(readPersistedContextUsage(messages, 'codex'), undefined)
  assert.deepEqual(readPersistedContextUsage(messages, 'claude'), { used: 150000, size: 200000 })
})

// ---------------------------------------------------------------------------
// 外部 store
// ---------------------------------------------------------------------------

test('the store keeps one snapshot per card and notifies only that card subscribers', () => {
  resetContextUsageStoreForTests()
  let cardANotifications = 0
  let cardBNotifications = 0
  const unsubscribeA = subscribeContextUsage('card-a', () => {
    cardANotifications += 1
  })
  const unsubscribeB = subscribeContextUsage('card-b', () => {
    cardBNotifications += 1
  })

  applyContextUsageEvent('card-a', { used: 44289 })
  applyContextUsageEvent('card-a', { used: 44289 })
  applyContextUsageEvent('card-a', { used: 44377, size: 200000 })

  assert.deepEqual(getContextUsageSnapshot('card-a'), { used: 44377, size: 200000 })
  assert.equal(getContextUsageSnapshot('card-b'), undefined)
  // 重复的同值事件不通知。
  assert.equal(cardANotifications, 2)
  assert.equal(cardBNotifications, 0)

  unsubscribeA()
  unsubscribeB()
  applyContextUsageEvent('card-a', { used: 50000 })
  assert.equal(cardANotifications, 2)
})

test('while a turn is running the live value wins, including an explicit unknown', () => {
  resetContextUsageStoreForTests()
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 52000, size: 200000 }, 'claude'),
  ]
  const resolve = (streaming: boolean) =>
    resolveContextUsage({ cardId: 'card-a', messages, provider: 'claude', streaming })

  // 重启后接上一个还在跑的回合，store 是空的：从消息里恢复。
  assert.deepEqual(resolve(true), { used: 52000, size: 200000 })

  // 开了新会话：占用明确未知，不能再回落到旧会话的落盘值。
  clearContextUsage('card-a')
  assert.deepEqual(resolve(true), {})

  applyContextUsageEvent('card-a', { used: 3000 })
  assert.deepEqual(resolve(true), { used: 3000 })
})

test('between turns only the recorded value counts', () => {
  resetContextUsageStoreForTests()
  // 上一个回合留在 store 里的值。
  applyContextUsageEvent('card-a', { used: 120000, size: 200000 })

  // 用户恢复了另一段归档对话：消息整段换掉，落盘值跟着消息走。
  const restoredArchive = [
    attachContextUsageMeta(durationMessage('d-9'), { used: 30000, size: 200000 }, 'claude'),
  ]

  assert.deepEqual(
    resolveContextUsage({ cardId: 'card-a', messages: restoredArchive, provider: 'claude', streaming: false }),
    { used: 30000, size: 200000 },
  )
  // 清空对话之后什么都不显示。
  assert.equal(
    resolveContextUsage({ cardId: 'card-a', messages: [], provider: 'claude', streaming: false }),
    undefined,
  )
})

test('the first event of a resumed turn starts from the recorded value', () => {
  resetContextUsageStoreForTests()

  // Claude 的 message_start 只带占用、不带窗口：窗口要沿用落盘的，否则百分比会消失一整个回合。
  applyContextUsageEvent('card-a', { used: 53000 }, () => ({ used: 52000, size: 200000 }))
  assert.deepEqual(getContextUsageSnapshot('card-a'), { used: 53000, size: 200000 })

  // store 里已经有值之后不再看落盘值。
  applyContextUsageEvent('card-a', { used: 54000 }, () => ({ used: 1, size: 1 }))
  assert.deepEqual(getContextUsageSnapshot('card-a'), { used: 54000, size: 200000 })
})

test('a new turn re-seeds the store and a removed card is forgotten', () => {
  resetContextUsageStoreForTests()
  let notifications = 0
  const unsubscribe = subscribeContextUsage('card-a', () => {
    notifications += 1
  })

  applyContextUsageEvent('card-a', { used: 120000, size: 200000 })
  seedContextUsage('card-a', { used: 30000, size: 200000 })
  assert.deepEqual(getContextUsageSnapshot('card-a'), { used: 30000, size: 200000 })

  forgetContextUsage('card-a')
  assert.equal(getContextUsageSnapshot('card-a'), undefined)
  assert.equal(notifications, 3)

  // 没有条目时再删一次不通知。
  forgetContextUsage('card-a')
  assert.equal(notifications, 3)
  unsubscribe()
})

test('the store remembers whether the CLI reported a compaction during the current turn', () => {
  resetContextUsageStoreForTests()

  // 回合开始：还没压缩过。普通的占用上报不算。
  seedContextUsage('card-a', { used: 170000, size: 200000 })
  assert.equal(hasContextCompactedDuringRun('card-a'), false)
  applyContextUsageEvent('card-a', { used: 171000 })
  assert.equal(hasContextCompactedDuringRun('card-a'), false)

  applyContextUsageEvent('card-a', { reset: true })
  assert.equal(hasContextCompactedDuringRun('card-a'), true)
  assert.equal(hasContextCompactedDuringRun('card-b'), false)

  // 压缩之后的第一次真实占用到了（基线记下了）：这个回合仍然是「压缩过」的。
  applyContextUsageEvent('card-a', { used: 45261 })
  assert.equal(getContextUsageSnapshot('card-a')?.awaitingBaseline, undefined)
  assert.equal(hasContextCompactedDuringRun('card-a'), true)

  // 下一个回合从头算。
  seedContextUsage('card-a', { used: 45261, size: 200000, baselineUsed: 45261 })
  assert.equal(hasContextCompactedDuringRun('card-a'), false)
})

test('a merged backlog entry carrying reset and occupancy still counts as a compaction', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 170000, size: 200000 })

  // 重连时服务端把整个回合的事件折成一条：reset 和压缩后的占用一起到。
  applyContextUsageEvent('card-a', { reset: true, used: 45261, size: 200000 })

  assert.deepEqual(getContextUsageSnapshot('card-a'), {
    used: 45261,
    size: 200000,
    baselineUsed: 45261,
  })
  assert.equal(hasContextCompactedDuringRun('card-a'), true)
})

test('a repeated compaction report and a removed card are both handled', () => {
  resetContextUsageStoreForTests()

  // 快照本来就在「等基线」：再来一条 reset 不改变快照，但这个回合确实压缩过。
  seedContextUsage('card-a', { size: 200000, awaitingBaseline: true })
  applyContextUsageEvent('card-a', { reset: true })
  assert.equal(hasContextCompactedDuringRun('card-a'), true)

  forgetContextUsage('card-a')
  assert.equal(hasContextCompactedDuringRun('card-a'), false)

  // 开新会话（clearContextUsage）同样从头算。
  applyContextUsageEvent('card-b', { reset: true })
  clearContextUsage('card-b')
  assert.equal(hasContextCompactedDuringRun('card-b'), false)
})

// ---------------------------------------------------------------------------
// 发送前要不要先压缩
// ---------------------------------------------------------------------------

const decision = (patch: Partial<AutoCompactDecisionInput> = {}): AutoCompactDecisionInput => ({
  enabled: true,
  thresholdPercent: 80,
  provider: 'claude',
  origin: 'user',
  hasResumableSession: true,
  hasSendContent: true,
  isSlashCommand: false,
  isToolCard: false,
  providerUnavailable: false,
  answersAskUser: false,
  recentlyAttempted: false,
  usage: { used: 170000, size: 200000 },
  ...patch,
})

test('a nearly full context is compacted before the user message goes out', () => {
  assert.equal(shouldAutoCompactBeforeSend(decision()), true)
  // 刚好到阈值也算。
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: { used: 160000, size: 200000 } })), true)
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: { used: 159999, size: 200000 } })), false)
})

test('auto compaction respects the switch and the configured threshold', () => {
  assert.equal(shouldAutoCompactBeforeSend(decision({ enabled: false })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ thresholdPercent: 90 })), false)
  assert.equal(
    shouldAutoCompactBeforeSend(
      decision({ thresholdPercent: 50, usage: { used: 100000, size: 200000 } }),
    ),
    true,
  )
})

test('auto compaction needs real numbers, never a guess', () => {
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: undefined })), false)
  // 不知道窗口大小就不压。
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: { used: 170000 } })), false)
  // 刚压缩完、占用未知也不压。
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: { size: 200000 } })), false)
})

test('auto compaction only runs for a hand-typed message on a resumable Claude or Codex session', () => {
  assert.equal(shouldAutoCompactBeforeSend(decision({ provider: 'codex' })), true)
  // Gemini 没有 /compact。
  assert.equal(shouldAutoCompactBeforeSend(decision({ provider: 'gemini' })), false)
  // 鞭策 / 计划唤醒这类自动发送不触发：它们的来源标记不能在排队里丢掉。
  assert.equal(shouldAutoCompactBeforeSend(decision({ origin: 'auto-urge' })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ origin: 'wake-timer-release' })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ origin: 'auto-compact' })), false)
  // 新会话没有可压的上下文。
  assert.equal(shouldAutoCompactBeforeSend(decision({ hasResumableSession: false })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ hasSendContent: false })), false)
  // 用户自己敲的斜杠命令（包括 /compact）原样发出。
  assert.equal(shouldAutoCompactBeforeSend(decision({ isSlashCommand: true })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ isToolCard: true })), false)
  assert.equal(shouldAutoCompactBeforeSend(decision({ providerUnavailable: true })), false)
})

test('answering a question or a plan approval is never preceded by a compaction', () => {
  // 回答必须紧跟在提问后面：中间插一条 /compact，计划审批就认不出这是在回答它。
  assert.equal(shouldAutoCompactBeforeSend(decision({ answersAskUser: true })), false)
})

test('auto compaction never chains', () => {
  // 上一次自动压缩之后紧跟的那次发送（就是被排队的用户消息）不再触发。
  assert.equal(shouldAutoCompactBeforeSend(decision({ recentlyAttempted: true })), false)

  // 压缩后占用没怎么长（不足窗口的 10%）：再压也压不下去，不触发。
  assert.equal(
    shouldAutoCompactBeforeSend(
      decision({ usage: { used: 170000, size: 200000, baselineUsed: 165000 } }),
    ),
    false,
  )
  // 长回来了（≥ 窗口的 10%）才再压。
  assert.equal(
    shouldAutoCompactBeforeSend(
      decision({ usage: { used: 170000, size: 200000, baselineUsed: 150000 } }),
    ),
    true,
  )
})

test('an app compaction that did not happen records the current occupancy as the baseline', () => {
  const before = { used: 170000, size: 200000 }
  const marked = markAutoCompactNotCompleted(before)

  // 把「现在的占用」记成基线；原快照不动。
  assert.deepEqual(marked, { used: 170000, size: 200000, baselineUsed: 170000 })
  assert.deepEqual(before, { used: 170000, size: 200000 })

  // 更早那次压缩留下的基线被顶掉：要比的是「这次尝试之后又涨了多少」。
  assert.deepEqual(
    markAutoCompactNotCompleted({ used: 170000, size: 200000, baselineUsed: 120000 }),
    { used: 170000, size: 200000, baselineUsed: 170000 },
  )

  // 不知道占用就没什么可记的。
  const windowOnly = { size: 200000, awaitingBaseline: true as const }
  assert.equal(markAutoCompactNotCompleted(windowOnly), windowOnly)
  assert.equal(markAutoCompactNotCompleted(undefined), undefined)
})

test('a failed app compaction is not retried on every other message, even after a restart', () => {
  // 失败的自动压缩回合留下的历史：上一回合的占用、被撤销的隐藏 /compact、这个回合自己的记录。
  const abandonedCompact = settlePendingCompactBoundary(
    markAppAutoCompactRun(
      markCompactBoundaryMessage(createMessage('user', '/compact'), {
        trigger: 'auto',
        hidden: true,
        pending: true,
      }),
      'stream-compact',
    ),
    { stopped: false, compactionObserved: false },
  )
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    abandonedCompact,
    attachContextUsageMeta(
      durationMessage('d-2'),
      markAutoCompactNotCompleted({ used: 170000, size: 200000 }),
      'claude',
    ),
  ]

  const restored = readPersistedContextUsage(messages, 'claude')
  assert.deepEqual(restored, { used: 170000, size: 200000, baselineUsed: 170000 })

  // 占用还在阈值之上，但这次尝试之后没怎么涨：不再白压一遍。
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: restored })), false)
  assert.equal(
    shouldAutoCompactBeforeSend(decision({ usage: reduceContextUsage(restored, { used: 185000 }) })),
    false,
  )
  // 又涨了窗口的 10%：值得再试一次。
  assert.equal(
    shouldAutoCompactBeforeSend(decision({ usage: reduceContextUsage(restored, { used: 190000 }) })),
    true,
  )
})

// ---------------------------------------------------------------------------
// 回合收尾：边界定下来、占用记下来
// ---------------------------------------------------------------------------

/** 和 reducer 的 upsertMessages 一个口径：按 id 整条替换。收尾只改已有的消息，不新增。 */
const applyRunEndUpdates = (messages: ChatMessage[], updates: ChatMessage[]) => {
  for (const update of updates) {
    assert.ok(
      messages.some((message) => message.id === update.id),
      `run-end update ${update.id} must target an existing message`,
    )
  }

  return messages.map((message) => updates.find((update) => update.id === message.id) ?? message)
}

const pendingAppCompact = (streamId = 'stream-compact') =>
  markAppAutoCompactRun(
    markCompactBoundaryMessage(createMessage('user', '/compact'), {
      trigger: 'auto',
      hidden: true,
      pending: true,
    }),
    streamId,
  )

test('recording occupancy again on the same message replaces the earlier record', () => {
  // 没有 run-duration 消息可挂的回合会把占用记到「最后一条消息」上，那条消息可能已经带着
  // 上一回合的记录。旧的键不能留下来和新的混在一起。
  const first = attachContextUsageMeta(
    durationMessage('d-1'),
    { used: 170000, size: 200000, baselineUsed: 120000 },
    'claude',
  )
  const second = attachContextUsageMeta(first, { size: 200000, awaitingBaseline: true }, 'claude')

  assert.deepEqual(readPersistedContextUsage([second], 'claude'), {
    size: 200000,
    awaitingBaseline: true,
  })
  assert.equal(second.meta?.contextUsageUsed, undefined)
  assert.equal(second.meta?.contextUsageBaseline, undefined)
  assert.equal(second.meta?.kind, 'run-duration')

  // 同一份占用再记一遍：原样返回，收尾时不产生多余的更新。
  assert.equal(
    attachContextUsageMeta(second, { size: 200000, awaitingBaseline: true }, 'claude'),
    second,
  )
  // 换了 provider 就不是同一份记录了。
  assert.notEqual(
    attachContextUsageMeta(second, { size: 200000, awaitingBaseline: true }, 'codex'),
    second,
  )
})

test('a turn that ends with background work still running records its occupancy', () => {
  // 后台任务 / 定时唤醒还挂着的回合不算「逻辑上跑完」，没有 run-duration 消息。
  // 带后台任务的长会话每一轮都是这样收尾的——不记的话指示器一直停在很久以前的数，
  // 发送前的自动压缩也永远不触发。
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 40000, size: 200000 }, 'claude'),
    createMessage('user', '在后台跑一下构建'),
    createMessage('assistant', '已经在后台跑了，跑完我再看结果。', { provider: 'claude' }),
  ]

  const updates = settleRunEndMessages({
    messages,
    provider: 'claude',
    boundary: undefined,
    usage: { used: 166000, size: 200000 },
  })

  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.id, messages[2]?.id)
  assert.equal(updates[0]?.content, messages[2]?.content)
  assert.equal(updates[0]?.meta?.provider, 'claude')

  const settled = applyRunEndUpdates(messages, updates)
  assert.deepEqual(readPersistedContextUsage(settled, 'claude'), { used: 166000, size: 200000 })
  assert.equal(
    shouldAutoCompactBeforeSend(decision({ usage: readPersistedContextUsage(settled, 'claude') })),
    true,
  )

  // 收尾时后面还会追加别的消息（改动摘要、「已停止」）：不影响读回。
  assert.deepEqual(
    readPersistedContextUsage([...settled, createMessage('system', '已停止')], 'claude'),
    { used: 166000, size: 200000 },
  )
})

test('an app compaction that completed keeps its boundary and records the compacted state', () => {
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact(),
    createMessage('system', '上下文已用 85%，先自动压缩，再发送你的消息。', { kind: 'log' }),
  ]

  const settled = applyRunEndUpdates(
    messages,
    settleRunEndMessages({
      messages,
      provider: 'claude',
      boundary: { stopped: false, compactionObserved: true },
      usage: { size: 200000, awaitingBaseline: true },
    }),
  )

  assert.equal(getPendingCompactBoundaryMessage(settled), null)
  assert.equal(isCompactBoundaryMessage(settled[1], 'claude'), true)
  assert.equal(isHiddenCompactBoundaryMessage(settled[1]!), true)
  assert.deepEqual(readPersistedContextUsage(settled, 'claude'), {
    size: 200000,
    awaitingBaseline: true,
  })
})

test('an app compaction that did not happen drops its boundary and is not retried right away', () => {
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact(),
    createMessage('system', '上下文已用 85%，先自动压缩，再发送你的消息。', { kind: 'log' }),
  ]

  const settled = applyRunEndUpdates(
    messages,
    settleRunEndMessages({
      messages,
      provider: 'claude',
      // 「正常结束」了，但 CLI 从头到尾没报过压缩。
      boundary: { stopped: false, compactionObserved: false },
      usage: markAutoCompactNotCompleted({ used: 170000, size: 200000 }),
    }),
  )

  // 边界撤销：更早的历史不折叠；那条 /compact 仍然不显示。
  assert.equal(getPendingCompactBoundaryMessage(settled), null)
  assert.equal(isCompactBoundaryMessage(settled[1], 'claude'), false)
  assert.equal(isHiddenCompactBoundaryMessage(settled[1]!), true)

  const restored = readPersistedContextUsage(settled, 'claude')
  assert.deepEqual(restored, { used: 170000, size: 200000, baselineUsed: 170000 })
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: restored })), false)
})

test('a boundary that is also the last message gets both changes in a single update', () => {
  // Codex 手动 /compact：压缩状态行还没来得及出现，回合就收尾了。
  const manualPending = markCompactBoundaryMessage(createMessage('user', '/compact'), { pending: true })
  const manualMessages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 230000, size: 258000 }, 'codex'),
    manualPending,
  ]
  const manualUpdates = settleRunEndMessages({
    messages: manualMessages,
    provider: 'codex',
    boundary: { stopped: false, compactionObserved: false },
    usage: { size: 258000, awaitingBaseline: true },
  })

  assert.equal(manualUpdates.length, 1)
  const manualSettled = applyRunEndUpdates(manualMessages, manualUpdates)
  assert.equal(getPendingCompactBoundaryMessage(manualSettled), null)
  assert.equal(isCompactBoundaryMessage(manualSettled[1], 'codex'), true)
  assert.deepEqual(readPersistedContextUsage(manualSettled, 'codex'), {
    size: 258000,
    awaitingBaseline: true,
  })

  // App 发起的压缩没压成：同一条消息上既撤销边界、又记下「没压成」的占用。
  const appMessages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact(),
  ]
  const appUpdates = settleRunEndMessages({
    messages: appMessages,
    provider: 'claude',
    boundary: { stopped: true, compactionObserved: false },
    usage: markAutoCompactNotCompleted({ used: 170000, size: 200000 }),
  })

  assert.equal(appUpdates.length, 1)
  const appSettled = applyRunEndUpdates(appMessages, appUpdates)
  assert.equal(isCompactBoundaryMessage(appSettled[1], 'claude'), false)
  assert.deepEqual(readPersistedContextUsage(appSettled, 'claude'), {
    used: 170000,
    size: 200000,
    baselineUsed: 170000,
  })
})

test('a turn that is not finished leaves a pending boundary alone', () => {
  const messages = [pendingAppCompact(), createMessage('assistant', '压缩中')]

  const updates = settleRunEndMessages({
    messages,
    provider: 'claude',
    boundary: undefined,
    usage: { used: 170000, size: 200000 },
  })

  assert.deepEqual(
    updates.map((update) => update.id),
    [messages[1]!.id],
  )
  assert.notEqual(getPendingCompactBoundaryMessage(applyRunEndUpdates(messages, updates)), null)
})

test('a boundary that is still pending does not count as a compaction', () => {
  // 症状（要防的）：压缩回合进行中应用退出，重启后在「中断会话」提示里点了「不恢复」。那条隐藏的
  //   /compact 一直挂着，可 CLI 那边根本没压过：指示器消失，下一条消息不先压缩；更糟的是
  //   下一回合的第一次真实占用（其实还是 85% 左右）被记成「压缩后基线」随消息落盘，此后要再涨
  //   窗口的 10%（默认阈值下约 95%）才会再自动压缩。
  // 根因（2026-11-12 独立审查）：读回落盘值时把挂着的边界也当成「压过了」。
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact('stream-lost'),
    createMessage('system', '上下文已用 85%，先自动压缩，再发送你的消息。', { kind: 'log' }),
  ]

  const restored = readPersistedContextUsage(messages, 'claude')

  // 压缩前记下的占用仍然是「现在的占用」：指示器照常显示，下一条消息照常先压缩。
  assert.deepEqual(restored, { used: 170000, size: 200000 })
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: restored })), true)
  // 下一回合的第一次真实占用不是什么「压缩后基线」。
  assert.equal(reduceContextUsage(restored, { used: 171000 }).baselineUsed, undefined)

  // 用户手敲、还没跑完的 Codex /compact 同理：压没压成要等回合收尾才定。
  const manualMessages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 230000, size: 258000 }, 'codex'),
    markCompactBoundaryMessage(createMessage('user', '/compact'), { pending: true }),
  ]
  assert.deepEqual(readPersistedContextUsage(manualMessages, 'codex'), { used: 230000, size: 258000 })

  // 边界一旦定下来（不再挂着），更早的占用照旧作废。
  const settledMessages = manualMessages.map((message) =>
    settlePendingCompactBoundary(message, { stopped: false, compactionObserved: false }),
  )
  assert.equal(getPendingCompactBoundaryMessage(settledMessages), null)
  assert.deepEqual(readPersistedContextUsage(settledMessages, 'codex'), {
    size: 258000,
    awaitingBaseline: true,
  })
})

test('a boundary that already took effect mid-turn is not undone at the end of the turn', () => {
  // Codex 回合中途报了压缩完成，边界当场生效；之后用户停止了这个回合。
  const finalized = settlePendingCompactBoundary(pendingAppCompact(), {
    stopped: false,
    compactionObserved: true,
  })
  const messages = [finalized, createMessage('system', '已完成 Codex 会话上下文压缩。', { kind: 'log' })]

  const updates = settleRunEndMessages({
    messages,
    provider: 'codex',
    boundary: { stopped: true, compactionObserved: false },
    usage: undefined,
  })

  assert.deepEqual(updates, [])
  assert.equal(isCompactBoundaryMessage(messages[0], 'codex'), true)
})

test('the end of a turn with nothing to settle produces no updates', () => {
  const recorded = attachContextUsageMeta(
    createMessage('assistant', '好的'),
    { used: 52000, size: 200000 },
    'claude',
  )
  const messages = [createMessage('user', '继续'), recorded]
  const settle = (patch: Partial<Parameters<typeof settleRunEndMessages>[0]>) =>
    settleRunEndMessages({ messages, provider: 'claude', boundary: undefined, usage: undefined, ...patch })

  // 占用有 run-duration 消息可挂（usage 不传），也没有挂着的边界。
  assert.deepEqual(settle({}), [])
  assert.deepEqual(settle({ boundary: { stopped: false, compactionObserved: false } }), [])
  // 什么都不知道：不留空记录。
  assert.deepEqual(settle({ usage: {} }), [])
  // 和已经记下的一样：不重复写。
  assert.deepEqual(settle({ usage: { used: 52000, size: 200000 } }), [])
  // 还没有任何消息。
  assert.deepEqual(settle({ messages: [], usage: { used: 52000, size: 200000 } }), [])
})

// ---------------------------------------------------------------------------
// 回合收尾：各个出口（done、出错、等不到确认的停止）共用的那一步
// ---------------------------------------------------------------------------

const settleRunEnd = (patch: Partial<Parameters<typeof settleRunEndForCard>[0]> = {}) =>
  settleRunEndForCard({
    cardId: 'card-a',
    messages: [],
    provider: 'claude',
    isAutoCompactRun: false,
    boundary: { stopped: false },
    durationMessage: undefined,
    ...patch,
  })

const autoCompactNote = () =>
  createMessage('system', '上下文已用 85%，先自动压缩，再发送你的消息。', { kind: 'log' })

test('a finished turn records the live occupancy on its run-duration message', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 40000, size: 200000 })
  applyContextUsageEvent('card-a', { used: 52000 })
  const messages = [createMessage('user', '继续'), createMessage('assistant', '好的')]

  const runEnd = settleRunEnd({ messages, durationMessage: durationMessage('d-2') })

  // 占用挂在这一回合自己的耗时消息上，已有的消息一条都不用动。
  assert.deepEqual(runEnd.updates, [])
  assert.equal(runEnd.autoCompactNotCompleted, false)
  assert.equal(runEnd.durationMessage?.id, 'd-2')
  assert.equal(runEnd.durationMessage?.meta?.kind, 'run-duration')
  assert.deepEqual(readPersistedContextUsage([...messages, runEnd.durationMessage!], 'claude'), {
    used: 52000,
    size: 200000,
  })
})

test('a turn that ends without a run-duration message records on its last message', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 40000, size: 200000 })
  applyContextUsageEvent('card-a', { used: 166000 })
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 40000, size: 200000 }, 'claude'),
    createMessage('user', '在后台跑一下构建'),
    createMessage('assistant', '已经在后台跑了，跑完我再看结果。'),
  ]

  // 后台任务还挂着：回合不算跑完（boundary 不传），也没有耗时消息。
  const runEnd = settleRunEnd({ messages, boundary: undefined })

  assert.equal(runEnd.durationMessage, undefined)
  assert.deepEqual(
    runEnd.updates.map((update) => update.id),
    [messages[2]!.id],
  )
  assert.deepEqual(
    readPersistedContextUsage(applyRunEndUpdates(messages, runEnd.updates), 'claude'),
    { used: 166000, size: 200000 },
  )
})

test('an app compaction the CLI reported takes effect whether or not it was stopped afterwards', () => {
  for (const stopped of [false, true]) {
    resetContextUsageStoreForTests()
    seedContextUsage('card-a', { used: 170000, size: 200000 })
    applyContextUsageEvent('card-a', { reset: true })
    const messages = [
      attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
      pendingAppCompact(),
      autoCompactNote(),
    ]

    const runEnd = settleRunEnd({
      messages,
      isAutoCompactRun: true,
      boundary: { stopped },
      durationMessage: durationMessage('d-2'),
    })
    const settled = [...applyRunEndUpdates(messages, runEnd.updates), runEnd.durationMessage!]

    assert.equal(runEnd.autoCompactNotCompleted, false)
    assert.equal(getPendingCompactBoundaryMessage(settled), null)
    assert.equal(isCompactBoundaryMessage(settled[1], 'claude'), true)
    assert.deepEqual(readPersistedContextUsage(settled, 'claude'), {
      size: 200000,
      awaitingBaseline: true,
    })
  }
})

test('an app compaction the CLI never reported is undone and remembered as an attempt', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 170000, size: 200000 })
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact(),
    autoCompactNote(),
  ]

  // 回合「正常结束」了，但 CLI 从头到尾没报过压缩。
  const runEnd = settleRunEnd({
    messages,
    isAutoCompactRun: true,
    durationMessage: durationMessage('d-2'),
  })
  const settled = [...applyRunEndUpdates(messages, runEnd.updates), runEnd.durationMessage!]

  assert.equal(runEnd.autoCompactNotCompleted, true)
  assert.equal(getPendingCompactBoundaryMessage(settled), null)
  assert.equal(isCompactBoundaryMessage(settled[1], 'claude'), false)

  // 当时的占用记成基线：紧接着的发送、以及重启之后的发送，都不会再白压一遍。
  const restored = readPersistedContextUsage(settled, 'claude')
  assert.deepEqual(restored, { used: 170000, size: 200000, baselineUsed: 170000 })
  assert.equal(shouldAutoCompactBeforeSend(decision({ usage: restored })), false)
})

test('an app compaction that ends with background work still pending is settled on the spot', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 170000, size: 200000 })
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 170000, size: 200000 }, 'claude'),
    pendingAppCompact(),
    autoCompactNote(),
  ]

  // 上一回合留下的后台任务还在跑，所以这个压缩回合也不出耗时消息。边界不能留到下一回合再定：
  // 到那时「这一回合压没压成」的信号已经被下一回合的开头清掉了。
  const runEnd = settleRunEnd({ messages, isAutoCompactRun: true, durationMessage: undefined })
  const settled = applyRunEndUpdates(messages, runEnd.updates)

  assert.equal(runEnd.autoCompactNotCompleted, true)
  assert.equal(runEnd.durationMessage, undefined)
  assert.equal(getPendingCompactBoundaryMessage(settled), null)
  assert.equal(isCompactBoundaryMessage(settled[1], 'claude'), false)
  assert.deepEqual(readPersistedContextUsage(settled, 'claude'), {
    used: 170000,
    size: 200000,
    baselineUsed: 170000,
  })
})

test('a /compact the user typed follows the stop flag and never counts as a failed app compaction', () => {
  resetContextUsageStoreForTests()
  seedContextUsage('card-a', { used: 230000, size: 258000 })
  const messages = [markCompactBoundaryMessage(createMessage('user', '/compact'), { pending: true })]

  const finished = settleRunEnd({
    messages,
    provider: 'codex',
    boundary: { stopped: false },
    durationMessage: durationMessage('d-2'),
  })
  assert.equal(finished.autoCompactNotCompleted, false)
  assert.equal(isCompactBoundaryMessage(applyRunEndUpdates(messages, finished.updates)[0], 'codex'), true)

  // 出错 / 被停止：边界撤销，占用原样记下（不动基线）。
  const failed = settleRunEnd({
    messages,
    provider: 'codex',
    boundary: { stopped: true },
    durationMessage: durationMessage('d-3'),
  })
  const failedSettled = [...applyRunEndUpdates(messages, failed.updates), failed.durationMessage!]
  assert.equal(failed.autoCompactNotCompleted, false)
  assert.equal(isCompactBoundaryMessage(failedSettled[0], 'codex'), false)
  assert.deepEqual(readPersistedContextUsage(failedSettled, 'codex'), { used: 230000, size: 258000 })
})

test('a turn whose live occupancy is gone leaves the earlier record in place', () => {
  // 应用重启之后流也丢了：store 里没有这张卡，没有可记的东西。
  resetContextUsageStoreForTests()
  const duration = durationMessage('d-2')
  const messages = [
    attachContextUsageMeta(durationMessage('d-1'), { used: 52000, size: 200000 }, 'claude'),
    createMessage('user', '继续'),
  ]

  const runEnd = settleRunEnd({ messages, boundary: { stopped: true }, durationMessage: duration })

  assert.deepEqual(runEnd.updates, [])
  assert.equal(runEnd.durationMessage, duration)
  assert.deepEqual(readPersistedContextUsage([...messages, duration], 'claude'), {
    used: 52000,
    size: 200000,
  })
})

test('the reason shown after an abandoned app compaction is one short line', () => {
  assert.equal(summarizeAutoCompactFailureDetail(undefined), undefined)
  assert.equal(summarizeAutoCompactFailureDetail('  \n\t '), undefined)

  // CLI 的报错常常是多行的（状态行 + 一段 JSON）：折成一行。
  assert.equal(
    summarizeAutoCompactFailureDetail(' API Error: 400\n{"error":\n  "bad request"}\r\n'),
    'API Error: 400 {"error": "bad request"}',
  )

  // 整页 HTML 错误页之类的长报错：截到一个上限，说明行不能把对话刷屏。
  const shown = summarizeAutoCompactFailureDetail(`上游报错：${'x'.repeat(600)}`)
  assert.ok(shown)
  assert.ok(shown.startsWith('上游报错：xxx'))
  assert.ok(shown.endsWith('…'))
  assert.equal(shown.length, 201)

  // 刚好在上限以内的不截。
  assert.equal(summarizeAutoCompactFailureDetail('y'.repeat(200)), 'y'.repeat(200))
})

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

test('auto compaction is on at 80% by default, in the schema and in the default settings', () => {
  const parsed = appSettingsSchema.parse({})
  assert.equal(parsed.autoCompactEnabled, true)
  assert.equal(parsed.autoCompactThresholdPercent, 80)

  const defaults = createDefaultSettings()
  assert.equal(defaults.autoCompactEnabled, true)
  assert.equal(defaults.autoCompactThresholdPercent, 80)
})

test('persisted auto compaction settings are normalized into the supported range', () => {
  const normalize = (patch: Record<string, unknown>) => normalizeAppSettings(patch as never)

  assert.equal(normalize({ autoCompactEnabled: false }).autoCompactEnabled, false)
  assert.equal(normalize({ autoCompactEnabled: 'nope' }).autoCompactEnabled, true)
  assert.equal(normalize({}).autoCompactThresholdPercent, 80)
  assert.equal(normalize({ autoCompactThresholdPercent: 65 }).autoCompactThresholdPercent, 65)
  assert.equal(normalize({ autoCompactThresholdPercent: 72.6 }).autoCompactThresholdPercent, 73)
  assert.equal(normalize({ autoCompactThresholdPercent: 10 }).autoCompactThresholdPercent, 50)
  assert.equal(normalize({ autoCompactThresholdPercent: 100 }).autoCompactThresholdPercent, 95)
  assert.equal(normalize({ autoCompactThresholdPercent: 'high' }).autoCompactThresholdPercent, 80)
  assert.equal(normalize({ autoCompactThresholdPercent: Number.NaN }).autoCompactThresholdPercent, 80)
})

test('the settings reducer accepts the auto compaction switch and threshold', () => {
  const state = createDefaultState('D:/context-usage')
  const disabled = ideReducer(state, { type: 'updateSettings', patch: { autoCompactEnabled: false } })
  assert.equal(disabled.settings.autoCompactEnabled, false)

  const tuned = ideReducer(disabled, {
    type: 'updateSettings',
    patch: { autoCompactThresholdPercent: 99 },
  })
  assert.equal(tuned.settings.autoCompactThresholdPercent, 95)
  assert.equal(tuned.settings.autoCompactEnabled, false)
})
