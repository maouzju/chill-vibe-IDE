import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { ChatMessage } from '../shared/schema.ts'
import { GIT_TOOL_MODEL } from '../shared/models.ts'
import {
  evaluateAutoUrge,
  getLatestAssistantTurnText,
  getNextAutoUrgeToggleState,
  planAutoUrgeForCompletedCard,
  resolveEffectiveAutoUrge,
} from '../src/components/chat-auto-urge.ts'

let messageSequence = 0

const createChatMessage = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `msg-${++messageSequence}`,
  role,
  content,
  createdAt: '2026-04-12T00:00:00.000Z',
})

const createAssistantMessage = (content: string): ChatMessage => createChatMessage('assistant', content)

const createUserMessage = (content: string): ChatMessage => createChatMessage('user', content)

const createAskUserMessage = (content: string): ChatMessage => ({
  ...createAssistantMessage(content),
  meta: {
    kind: 'ask-user',
    structuredData: JSON.stringify({
      itemId: 'ask-user-1',
      kind: 'ask-user',
      header: '确认',
      question: content,
      options: [{ label: '继续', description: '继续验证。' }],
    }),
  },
})

test('manual activation sends the selected urge immediately when the chat is idle', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I still need more evidence.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('manual activation ignores old success keywords so turning auto urge back on stays enabled', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('Verified. YES')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('manual activation does not send while the chat is still streaming', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'streaming',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('Still checking.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'skip',
  })
})


test('stream completion sends an empty urge message as a continuation nudge', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: '   ',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I only have a guess so far.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: '',
  })
})

test('stream completion still sends the urge when verification is not finished', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('I only have a guess so far.')],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('stream completion does not auto-urge while Claude still has native background work', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [createAssistantMessage('Waiting for a background agent.')],
      backgroundWorkPending: true,
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('stream completion disables auto urge when the latest assistant turn contains the success keyword before a trailing assistant summary card', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('Please keep checking until you are sure.'),
        createAssistantMessage('The fix is verified. YES'),
        createAssistantMessage(''),
      ],
    },
  )

  assert.deepEqual(result, {
    kind: 'disable',
  })
})

test('stream completion never treats an ask-user question as success and waits for the answer instead', () => {
  // A success keyword inside the question text must not disable the urge, and
  // a pending ask-user question must block urging entirely (the agent is
  // waiting on the user, so nudging it would interrupt the question).
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('Fix the bug and verify it.'),
        createAssistantMessage('I still need confirmation before continuing.'),
        createAskUserMessage('If the problem is solved, reply YES; otherwise do not stop.'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('stream completion does not reuse a success keyword from an older assistant turn', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep verifying until the fix is proven.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('Fix the first problem.'),
        createAssistantMessage('That one is verified. YES'),
        createUserMessage('Now fix the second problem.'),
        createAssistantMessage('I still need more evidence for this one.'),
      ],
    },
  )

  assert.deepEqual(result, {
    kind: 'send',
    message: 'Keep verifying until the fix is proven.',
  })
})

test('composer toggle can re-enable auto urge for the current chat after the global feature was turned off', () => {
  const result = getNextAutoUrgeToggleState({
    featureEnabled: false,
    chatActive: false,
    status: 'idle',
  })

  assert.deepEqual(result, {
    featureEnabled: true,
    chatActive: true,
    shouldSendImmediately: true,
  })
})

test('composer toggle turns off only the current chat when auto urge is already available', () => {
  const result = getNextAutoUrgeToggleState({
    featureEnabled: true,
    chatActive: true,
    status: 'idle',
  })

  assert.deepEqual(result, {
    featureEnabled: true,
    chatActive: false,
    shouldSendImmediately: false,
  })
})

test('resolveEffectiveAutoUrge prefers the card own urge over the global urge', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: true,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: true, profileId: 'profile-card', source: 'card' })
})

test('resolveEffectiveAutoUrge applies the global urge to cards without their own urge', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: true, profileId: 'profile-global', source: 'global' })
})

test('resolveEffectiveAutoUrge never applies the global urge to tool cards', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: true,
    globalUrgeProfileId: 'profile-global',
    isToolCard: true,
  })

  assert.deepEqual(result, { active: false, profileId: 'profile-card', source: 'none' })
})

test('resolveEffectiveAutoUrge stays inactive when neither the card nor the global urge is on', () => {
  const result = resolveEffectiveAutoUrge({
    cardAutoUrgeActive: false,
    cardAutoUrgeProfileId: 'profile-card',
    globalUrgeActive: false,
    globalUrgeProfileId: 'profile-global',
    isToolCard: false,
  })

  assert.deepEqual(result, { active: false, profileId: 'profile-card', source: 'none' })
})

test('stream-finished never urges while the latest turn has an unanswered ask-user question', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('做完这个任务'),
        createAssistantMessage('我有一个问题需要确认。'),
        createAskUserMessage('要用哪种方案？'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('manual activation is also blocked by an unanswered ask-user question', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [createUserMessage('任务'), createAskUserMessage('选哪个？')],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('an answered ask-user question no longer blocks urging', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('任务'),
        createAskUserMessage('选哪个？'),
        createUserMessage('选 A'),
        createAssistantMessage('好的，继续做但还没做完。'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'send', message: 'Keep going.' })
})

test('local-model judge mode returns a judge request instead of matching keywords', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      judgeMode: 'local-model',
      messages: [
        createUserMessage('任务'),
        createAssistantMessage('YES 我觉得差不多了但没验证。'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'judge', message: 'Keep going.' })
})

test('local-model judge mode is still blocked by an unanswered ask-user question', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: '',
      judgeMode: 'local-model',
      messages: [createUserMessage('任务'), createAskUserMessage('选哪个？')],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

const createRunStoppedMessage = (stopReason: 'manual' | 'user-interrupt'): ChatMessage => ({
  ...createChatMessage('system', stopReason === 'user-interrupt' ? '已打断本次回答' : '已停止本次运行'),
  meta: {
    kind: 'run-stopped',
    stopReason,
  },
})

test('stream-finished never urges a turn the user stopped manually', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('做完这个任务'),
        createAssistantMessage('做到一半。'),
        createRunStoppedMessage('manual'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('stream-finished never urges a turn the user interrupted with a new send', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('做完这个任务'),
        createRunStoppedMessage('user-interrupt'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('local-model judge mode also skips a manually stopped turn without judging', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: '',
      judgeMode: 'local-model',
      messages: [
        createUserMessage('任务'),
        createAssistantMessage('停在半路。'),
        createRunStoppedMessage('manual'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('global urge activation does not urge a card whose latest turn was stopped manually', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
      source: 'global',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('任务'),
        createAssistantMessage('停在半路。'),
        createRunStoppedMessage('manual'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'skip' })
})

test('card-level manual activation still urges after a manual stop because the user explicitly asked', () => {
  const result = evaluateAutoUrge(
    {
      type: 'manual-activation',
      status: 'idle',
      source: 'card',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('任务'),
        createAssistantMessage('停在半路。'),
        createRunStoppedMessage('manual'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'send', message: 'Keep going.' })
})

test('a manual stop in an older turn does not block urging the latest turn', () => {
  const result = evaluateAutoUrge(
    {
      type: 'stream-finished',
      previousStatus: 'streaming',
      status: 'idle',
    },
    {
      active: true,
      enabled: true,
      message: 'Keep going.',
      successKeyword: 'YES',
      messages: [
        createUserMessage('第一个任务'),
        createRunStoppedMessage('manual'),
        createUserMessage('继续做第二个任务'),
        createAssistantMessage('还没做完。'),
      ],
    },
  )

  assert.deepEqual(result, { kind: 'send', message: 'Keep going.' })
})

test('getLatestAssistantTurnText returns the last assistant prose of the latest turn', () => {
  const text = getLatestAssistantTurnText([
    createUserMessage('旧任务'),
    createAssistantMessage('旧回复'),
    createUserMessage('新任务'),
    createAssistantMessage('中间进展。'),
    createAskUserMessage('这个不该被选中'),
    createAssistantMessage('最终结论：还差一步。'),
  ])

  assert.equal(text, '最终结论：还差一步。')
})

test('getLatestAssistantTurnText returns an empty string when the latest turn has no assistant prose', () => {
  assert.equal(getLatestAssistantTurnText([createUserMessage('任务')]), '')
})

const urgeSettings = (
  patch: Partial<Parameters<typeof planAutoUrgeForCompletedCard>[1]> = {},
): Parameters<typeof planAutoUrgeForCompletedCard>[1] => ({
  autoUrgeEnabled: true,
  autoUrgeProfiles: [
    {
      id: 'profile-done',
      name: '全部做完',
      message: '继续，直到全部做完',
      successKeyword: '全部做完了',
      judgeMode: 'keyword',
      judgeModel: '',
    },
  ],
  autoUrgeMessage: '继续',
  autoUrgeSuccessKeyword: 'YES',
  autoUrgeGlobalControlEnabled: false,
  autoUrgeGlobalActive: false,
  autoUrgeGlobalProfileId: 'profile-done',
  repeatLoopEnabled: false,
  ...patch,
})

const urgeCard = (
  patch: Partial<Parameters<typeof planAutoUrgeForCompletedCard>[0]> = {},
): Parameters<typeof planAutoUrgeForCompletedCard>[0] => ({
  messages: [createUserMessage('帮我做完'), createAssistantMessage('尚未解决：还差一步。')],
  sessionId: 'session-1',
  status: 'idle',
  model: 'claude-opus-4-8',
  autoUrgeActive: true,
  autoUrgeProfileId: 'profile-done',
  ...patch,
})

test('completed card still urges when the success keyword is missing, even if its tab is not mounted', () => {
  // 症状：开着鞭策的卡在非活动 tab 上跑完，永远不再被鞭策（2026-08-27 用户 state.json
  //   实证：工作区 3 的 pane 有 5 个 tab，armed 卡不是 activeTabId，status 已 idle，
  //   末尾是「尚未解决：…」却停着不动）。
  // 根因：判定原先只挂在 ChatCard 的 streaming→idle effect 上，而非活动 tab 的
  //   ChatCard 整棵子树被卸载（只有 Git 卡在 cardKeepsPaneRuntimeWhenInactive 白名单里）。
  // 被否决：把聊天卡加进常驻白名单 —— 会让所有非活动卡常驻渲染，重开 streaming
  //   textarea 抢焦点那一族老坑。
  const plan = planAutoUrgeForCompletedCard(urgeCard(), urgeSettings())

  assert.deepEqual(plan, {
    kind: 'send',
    message: '继续，直到全部做完',
    source: 'card',
    judgeModel: '',
  })
})

test('completed card disables card-level auto urge once the success keyword lands', () => {
  const plan = planAutoUrgeForCompletedCard(
    urgeCard({
      messages: [createUserMessage('帮我做完'), createAssistantMessage('全部做完了')],
    }),
    urgeSettings(),
  )

  assert.deepEqual(plan, { kind: 'disable', source: 'card', judgeModel: '' })
})

test('completed card skips auto urge while native background work is still pending', () => {
  const plan = planAutoUrgeForCompletedCard(
    urgeCard({ backgroundWorkPending: true }),
    urgeSettings(),
  )

  assert.deepEqual(plan, { kind: 'skip' })
})

test('completed card skips auto urge when the card is no longer idle', () => {
  const plan = planAutoUrgeForCompletedCard(urgeCard({ status: 'streaming' }), urgeSettings())

  assert.deepEqual(plan, { kind: 'skip' })
})

test('completed tool card is never swept by the global urge', () => {
  const plan = planAutoUrgeForCompletedCard(
    urgeCard({ model: GIT_TOOL_MODEL, autoUrgeActive: false }),
    urgeSettings({ autoUrgeGlobalControlEnabled: true, autoUrgeGlobalActive: true }),
  )

  assert.deepEqual(plan, { kind: 'skip' })
})

test('completed card follows the global urge profile when the card switch is off', () => {
  const plan = planAutoUrgeForCompletedCard(
    urgeCard({ autoUrgeActive: false }),
    urgeSettings({ autoUrgeGlobalControlEnabled: true, autoUrgeGlobalActive: true }),
  )

  assert.deepEqual(plan, {
    kind: 'send',
    message: '继续，直到全部做完',
    source: 'global',
    judgeModel: '',
  })
})

test('completed card defers to the repeat loop instead of urging on top of it', () => {
  const plan = planAutoUrgeForCompletedCard(
    urgeCard({ repeatLoopActive: true }),
    urgeSettings({ repeatLoopEnabled: true }),
  )

  assert.deepEqual(plan, { kind: 'skip' })
})

test('stream-not-found graceful completion still enters the stable auto-urge broadcast', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const branchStart = appSource.indexOf("if (message === 'Stream not found.')")
  const branchEnd = appSource.indexOf("if (hint === 'switch-config'", branchStart)

  assert.notEqual(branchStart, -1)
  assert.notEqual(branchEnd, -1)
  assert.match(
    appSource.slice(branchStart, branchEnd),
    /scheduleStableWakeTimerCompletion\(card\.id\)/,
  )
})
