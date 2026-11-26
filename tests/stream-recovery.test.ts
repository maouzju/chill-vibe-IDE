import assert from 'node:assert/strict'
import test from 'node:test'

import { attachImagesToMessageMeta } from '../shared/chat-attachments.ts'
import { isClaudePoisonedHistoryError } from '../server/provider-stream-recovery.ts'
import { forkProviderSession } from '../server/session-fork.ts'
import { providerSupportsLosslessSessionFork } from '../shared/provider-session-fork.ts'
import {
  createStreamRecoveryRetryScheduler,
  resolveManualRecoveryPlan,
  isContextExcludedMessage,
  getRecoverableStreamRetryDelayMs,
  getRecoverableStreamRetryLimit,
  getRecoverableStreamErrorSessionId,
  isClaudePreviouslyRejectedUpstreamError,
  shouldRecoverPreviouslyRejectedWithNativeCheckpoint,
  resolveNextFailedResumeSessionAttempt,
  resolveFreshSessionRecoveryTurn,
  resolveStreamRecoveryMode,
  resolveStreamRecoveryCheckpointTurn,
  shouldAbandonFailedAutoCompactRun,
  shouldFallbackToFreshSessionAfterResumeLoop,
  shouldFallbackToFreshSessionAfterTransientResumeLoop,
  shouldKeepRecoveringResumeWithFreshSession,
  shouldKeepRecoveringTransientResumeWithFreshSession,
  shouldScheduleFallbackRetryAfterStreamFailure,
  shouldResetStreamRecoveryAttemptsForActivity,
  shouldResetStreamRecoveryAttemptsForText,
} from '../src/stream-recovery.ts'

test('previously-rejected Claude relay errors require a fresh session', () => {
  assert.equal(
    isClaudePreviouslyRejectedUpstreamError(
      'API Error: 400 This request was previously rejected by the upstream provider and will not be retried.',
    ),
    true,
  )
  assert.equal(isClaudePreviouslyRejectedUpstreamError('API Error: 500 server-side issue, usually temporary'), false)
})

test('previously-rejected recovery keeps the native conversation checkpoint', () => {
  assert.equal(
    shouldRecoverPreviouslyRejectedWithNativeCheckpoint({ provider: 'claude', hasSessionId: true }),
    true,
  )
  assert.equal(
    shouldRecoverPreviouslyRejectedWithNativeCheckpoint({ provider: 'codex', hasSessionId: true }),
    false,
  )
})

test('the Chinese relay wording of previously-rejected is recognised too', () => {
  const zh =
    'API Error: 400 这段内容此前被上游拒绝过且高度相似，不再重试。请修改内容。 (request id: 20261118142717088-58ec0d04)'
  assert.equal(isClaudePreviouslyRejectedUpstreamError(zh), true)
  assert.equal(isClaudePoisonedHistoryError(zh), true)
  assert.equal(isClaudePoisonedHistoryError('API Error: 400 请求参数不合法'), false)
})

test('fresh Claude recovery replays only the latest user turn after appended error messages', () => {
  const turn = resolveFreshSessionRecoveryTurn({
    messages: [
      recoveryMessage('old-user', 'user', '旧需求'),
      recoveryMessage('old-assistant', 'assistant', '旧回复'),
      recoveryMessage('current-user', 'user', '请继续处理当前问题'),
      recoveryMessage('error', 'system', 'API Error: 400 This request was previously rejected by the upstream provider'),
    ],
  })

  assert.equal(turn?.prompt, '请继续处理当前问题')
  assert.deepEqual(turn?.attachments, [])
})

test('fresh Claude recovery refuses to replay a completed older turn on an empty continuation', () => {
  const turn = resolveFreshSessionRecoveryTurn({
    streamId: 'stream-now',
    messages: [
      recoveryMessage('old-user', 'user', '已经做完的旧需求'),
      recoveryMessage('old-assistant', 'assistant', '做完了', { streamId: 'stream-old' }),
      recoveryMessage('error', 'system', 'API Error: 400 previously rejected by the upstream provider'),
    ],
  })

  assert.equal(turn, null)
})

test('previously-rejected Claude errors do not enter the delayed fallback retry loop', () => {
  assert.equal(
    shouldScheduleFallbackRetryAfterStreamFailure({
      previouslyRejectedUpstream: true,
      lostStreamStopReason: false,
      sensitiveWordRejection: false,
    }),
    false,
  )
  assert.equal(
    shouldScheduleFallbackRetryAfterStreamFailure({
      previouslyRejectedUpstream: false,
      lostStreamStopReason: false,
      sensitiveWordRejection: false,
    }),
    true,
  )
})

test('an app-initiated compaction turn is only ever re-attached, never resumed or replayed', () => {
  // 重连同一条流：回合 id 不变，收尾时还认得出它是自动压缩回合。
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      previouslyRejectedUpstream: false,
    }),
    false,
  )
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: true,
      recoveryMode: undefined,
      previouslyRejectedUpstream: false,
    }),
    false,
  )

  // 续传会换回合 id、发空提示或另开会话重放 /compact：一律放弃这次压缩。
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: true,
      recoveryMode: 'resume-session',
      previouslyRejectedUpstream: false,
    }),
    true,
  )
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      previouslyRejectedUpstream: true,
    }),
    true,
  )
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: false,
      recoveryMode: undefined,
      previouslyRejectedUpstream: false,
    }),
    true,
  )
  assert.equal(
    shouldAbandonFailedAutoCompactRun({
      recoverable: undefined,
      recoveryMode: undefined,
      previouslyRejectedUpstream: false,
    }),
    true,
  )
})

const recoveryMessage = (
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  meta?: Record<string, string>,
) => ({ id, role, content, createdAt: '2026-07-15T01:08:29.358Z', meta })

test('recoverable resume-session errors keep the resume strategy when a session id exists', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      true,
    ),
    'resume-session',
  )
})

test('recoverable resume-session errors expose their fallback session id', () => {
  assert.equal(
    getRecoverableStreamErrorSessionId({
      recoverable: true,
      recoveryMode: 'resume-session',
      sessionId: ' session-1 ',
    }),
    'session-1',
  )

  assert.equal(
    getRecoverableStreamErrorSessionId({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      sessionId: 'session-1',
    }),
    null,
  )
})

test('recoverable resume-session errors fall back to reattach without a session id', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: true,
        recoveryMode: 'resume-session',
      },
      false,
    ),
    'reattach-stream',
  )
})

test('non-recoverable errors do not trigger stream recovery', () => {
  assert.equal(
    resolveStreamRecoveryMode(
      {
        recoverable: false,
      },
      true,
    ),
    null,
  )
})

test('transport reconnect placeholders do not reset the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting... 1/5'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting 1/5'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForText('Reconnecting... 1/5Reconnecting... 2/5'), false)
})

test('provider API error lines echoed as assistant text do not reset the recovery retry budget', () => {
  assert.equal(
    shouldResetStreamRecoveryAttemptsForText(
      'API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request',
    ),
    false,
  )
  assert.equal(shouldResetStreamRecoveryAttemptsForText('API Error: 500 Internal Server Error'), false)
})

test('real assistant output still resets the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForText('我已经恢复并继续处理了。'), true)
  assert.equal(shouldResetStreamRecoveryAttemptsForText(''), false)
})

test('only meaningful activity resets the recovery retry budget', () => {
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('session'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('log'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity'), true)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity', 'reasoning'), false)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('activity', 'command'), true)
  assert.equal(shouldResetStreamRecoveryAttemptsForActivity('assistant_message'), true)
})

test('repeated transient resume loops fall back to a fresh session escape hatch', () => {
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 2,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 3,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )
})

test('repeated ordinary stalled resume loops also fall back to a fresh session', () => {
  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: true,
      resumeAttempt: 1,
      maxResumeAttempts: 2,
    }),
    false,
  )

  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: true,
      resumeAttempt: 2,
      maxResumeAttempts: 2,
    }),
    true,
  )
})

test('upstream transport failures after real progress start a new failed-resume streak', () => {
  const malformed =
    'API Error: API returned an empty or malformed response (HTTP 200) — check for a proxy or gateway intercepting the request.'
  assert.equal(
    resolveNextFailedResumeSessionAttempt({ previousAttempt: 1, madeMeaningfulProgress: true, message: malformed }),
    1,
  )
  assert.equal(
    resolveNextFailedResumeSessionAttempt({
      previousAttempt: 1,
      madeMeaningfulProgress: true,
      message: 'API Error: 503 No accounts are currently available. Please try again later.',
    }),
    1,
  )
  // No progress between failures: the tip may really be poisoned, keep the escape hatch.
  assert.equal(
    resolveNextFailedResumeSessionAttempt({ previousAttempt: 1, madeMeaningfulProgress: false, message: malformed }),
    2,
  )
  // Stall-class failures can follow partial output on a poisoned Codex tip.
  assert.equal(
    resolveNextFailedResumeSessionAttempt({
      previousAttempt: 1,
      madeMeaningfulProgress: true,
      message: 'Codex stalled after emitting stream output.',
    }),
    2,
  )
})

test('recoverable resume failures without a usable session keep recovering through a fresh session', () => {
  assert.equal(
    shouldKeepRecoveringResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      hasSessionId: false,
      resumeAttempt: 1,
      maxResumeAttempts: 2,
    }),
    true,
  )
})

test('fresh-session fallback ignores unrecoverable and reattach-only failures', () => {
  const base = {
    recoverable: true,
    recoveryMode: 'resume-session' as const,
    hasSessionId: true,
    resumeAttempt: 2,
    maxResumeAttempts: 2,
  }

  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({ ...base, recoverable: false }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterResumeLoop({ ...base, recoveryMode: 'reattach-stream' }),
    false,
  )
})

test('fresh-session fallback only applies to recoverable placeholder-only session resumes', () => {
  const base = {
    recoverable: true,
    recoveryMode: 'resume-session' as const,
    transientOnly: true,
    hasSessionId: true,
    transientResumeAttempt: 4,
    maxTransientResumeAttempts: 3,
  }

  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      recoverable: false,
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      recoveryMode: 'reattach-stream',
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      transientOnly: false,
    }),
    false,
  )
  assert.equal(
    shouldFallbackToFreshSessionAfterTransientResumeLoop({
      ...base,
      hasSessionId: false,
    }),
    false,
  )
})

test('transient-only resume recovery keeps using fresh-session recovery after the session id is gone', () => {
  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 1,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: true,
      transientResumeAttempt: 3,
      maxTransientResumeAttempts: 3,
    }),
    true,
  )
})

test('fresh-session transient recovery does not apply to non-transient or non-resume failures', () => {
  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'reattach-stream',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: true,
      recoveryMode: 'resume-session',
      transientOnly: false,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )

  assert.equal(
    shouldKeepRecoveringTransientResumeWithFreshSession({
      recoverable: false,
      recoveryMode: 'resume-session',
      transientOnly: true,
      hasSessionId: false,
      transientResumeAttempt: 5,
      maxTransientResumeAttempts: 3,
    }),
    false,
  )
})

test('recoverable stream retry limit accepts unlimited and clamps invalid configured values', () => {
  assert.equal(getRecoverableStreamRetryLimit(6), 6)
  assert.equal(getRecoverableStreamRetryLimit(-1), Number.POSITIVE_INFINITY)
  assert.equal(getRecoverableStreamRetryLimit(0), 0)
  assert.equal(getRecoverableStreamRetryLimit(51), 6)
  assert.equal(getRecoverableStreamRetryLimit(undefined), 6)
})

test('checkpoint recovery selects the latest user turn when it is still the visible tail', () => {
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage('assistant-old', 'assistant', 'Earlier completed reply'),
      recoveryMessage('user-current', 'user', 'Finish the current repair'),
    ],
    streamId: 'stream-current',
  })

  assert.equal(turn?.message.id, 'user-current')
  assert.equal(turn?.prompt, 'Finish the current repair')
  assert.deepEqual(turn?.attachments, [])
})

test('checkpoint recovery accepts current-stream output after the unfinished user turn', () => {
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage('user-current', 'user', 'Finish the current repair'),
      recoveryMessage('reasoning-current', 'assistant', '', {
        kind: 'reasoning',
        streamId: 'stream-current',
      }),
    ],
    streamId: 'stream-current',
  })

  assert.equal(turn?.message.id, 'user-current')
})

test('checkpoint recovery rejects ambiguous old turns and empty continuations', () => {
  assert.equal(
    resolveStreamRecoveryCheckpointTurn({
      messages: [
        recoveryMessage('user-old', 'user', 'Old request'),
        recoveryMessage('assistant-old', 'assistant', 'Already completed'),
      ],
      streamId: 'stream-current',
    }),
    null,
  )

  assert.equal(
    resolveStreamRecoveryCheckpointTurn({
      messages: [recoveryMessage('user-empty', 'user', '   ')],
      streamId: 'stream-current',
    }),
    null,
  )
})

test('checkpoint recovery preserves attachment-only user turns', () => {
  const attachment = {
    id: 'image-current',
    fileName: 'evidence.png',
    mimeType: 'image/png' as const,
    sizeBytes: 2048,
  }
  const turn = resolveStreamRecoveryCheckpointTurn({
    messages: [
      recoveryMessage(
        'user-image',
        'user',
        '',
        attachImagesToMessageMeta([attachment]),
      ),
    ],
    streamId: 'stream-current',
  })

  assert.deepEqual(turn?.attachments, [attachment])
})

// 2026-11-16 实证：重试设为无限（resilientProxyMaxRetries = -1）时，两次续传之间最多只等 1.5 秒，
// 中转站吐了 2.5 小时空 200，同一张卡重试 639 次（约每 14 秒一次），每次新开一个带 3 万字种子的会话。
test('recoverable retries back off once a failure streak outlasts the fast window', () => {
  // 前 6 次保持原有节奏：短暂抖动要立刻接上。
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((retryCount) => getRecoverableStreamRetryDelayMs(retryCount, true)),
    [250, 500, 750, 1000, 1250, 1500],
  )
  // 之后每次翻倍，封顶 5 分钟（与兜底续传的起步间隔对齐）。
  assert.deepEqual(
    [6, 7, 8, 9].map((retryCount) => getRecoverableStreamRetryDelayMs(retryCount, true)),
    [3_000, 6_000, 12_000, 24_000],
  )
  assert.equal(getRecoverableStreamRetryDelayMs(13, true), 300_000)
  assert.equal(getRecoverableStreamRetryDelayMs(639, true), 300_000)

  // 2.5 小时的中转站故障：重试次数必须从几百次降到几十次。
  let elapsedMs = 0
  let attempts = 0
  while (elapsedMs < 2.5 * 60 * 60 * 1000) {
    elapsedMs += getRecoverableStreamRetryDelayMs(attempts, true) + 14_000
    attempts += 1
  }
  assert.ok(attempts < 60, `expected a bounded retry storm, got ${attempts} attempts`)

  // 不计预算的占位符错误没有连续失败计数可用，保持原样。
  assert.equal(getRecoverableStreamRetryDelayMs(0, false), 250)
  assert.equal(getRecoverableStreamRetryDelayMs(40, false), 250)
})

// 2026-11-18 用户反馈「手动停止的会话过一会又自己开了」。断线后等下一次续传的那段时间
// （2026-11-16 起最长 5 分钟）卡片仍显示运行中，但服务端那条流早已终态：停止请求打到死流上
// 是空操作（server.log 里 origin=manual / outcome=already-terminal），到点照样续传。
test('a stop during the wait for the next recovery retry cancels that retry', () => {
  const pending = new Map<number, () => void>()
  let nextHandle = 1
  const scheduler = createStreamRecoveryRetryScheduler({
    setTimer: (run) => {
      const handle = nextHandle++
      pending.set(handle, run)
      return handle
    },
    clearTimer: (handle) => {
      pending.delete(handle)
    },
  })
  const fired: string[] = []

  scheduler.schedule('card-a', () => fired.push('card-a'), 300_000)
  scheduler.schedule('card-b', () => fired.push('card-b'), 300_000)
  assert.equal(scheduler.isPending('card-a'), true)

  // 用户点了停止：这次续传必须被撤掉，并且要让调用方知道「这张卡刚才在等续传」。
  assert.equal(scheduler.cancel('card-a'), true)
  assert.equal(scheduler.isPending('card-a'), false)
  // 没有在等续传的卡：停止走原来的服务端路径。
  assert.equal(scheduler.cancel('card-a'), false)
  assert.equal(scheduler.cancel('card-never'), false)

  for (const run of [...pending.values()]) {
    run()
  }
  assert.deepEqual(fired, ['card-b'])
  // 到点触发后不再算「在等」，否则之后正常运行时点停止会被误判成本地收尾。
  assert.equal(scheduler.isPending('card-b'), false)
  assert.equal(scheduler.cancel('card-b'), false)
})

test('rescheduling a recovery retry for the same card replaces the previous one', () => {
  const pending = new Map<number, () => void>()
  let nextHandle = 1
  const scheduler = createStreamRecoveryRetryScheduler({
    setTimer: (run) => {
      const handle = nextHandle++
      pending.set(handle, run)
      return handle
    },
    clearTimer: (handle) => {
      pending.delete(handle)
    },
  })
  const fired: string[] = []

  scheduler.schedule('card-a', () => fired.push('first'), 250)
  scheduler.schedule('card-a', () => fired.push('second'), 250)
  assert.equal(pending.size, 1)

  for (const run of [...pending.values()]) {
    run()
  }
  assert.deepEqual(fired, ['second'])
})

// 玩家需求（2026-11-18）：不会发给模型的消息在会话里置灰。判据必须和「回放过滤 / CLI 回显」同口径。
// 2026-11-26 实证：一张 Gemini 卡 9 次兜底续传开了 9 个新会话，每次只带一份「跑过哪些命令」的清单，
// 文件内容一个字没有，模型只能把同一批文件重读一遍（151 条命令、0 句正文）。
test('manual and fallback recovery keep a Gemini session instead of restarting it from a seeded transcript', () => {
  assert.equal(
    resolveManualRecoveryPlan({
      provider: 'gemini',
      resumeSessionId: 'session-1',
      previousInPlaceResumeSessionId: undefined,
      madeMeaningfulProgress: false,
    }),
    'resume-in-place',
  )
  // 上一次原地续传跑出了真东西再断：会话是好的，接着续，上下文越攒越全。
  assert.equal(
    resolveManualRecoveryPlan({
      provider: 'gemini',
      resumeSessionId: 'session-1',
      previousInPlaceResumeSessionId: 'session-1',
      madeMeaningfulProgress: true,
    }),
    'resume-in-place',
  )
})

test('a Gemini session that died again without any output is abandoned for a fresh one', () => {
  assert.equal(
    resolveManualRecoveryPlan({
      provider: 'gemini',
      resumeSessionId: 'session-1',
      previousInPlaceResumeSessionId: 'session-1',
      madeMeaningfulProgress: false,
    }),
    'checkpoint-or-fresh',
  )
  // 卡已经换了会话：那次失败记在旧会话头上，新会话照样先原地续。
  assert.equal(
    resolveManualRecoveryPlan({
      provider: 'gemini',
      resumeSessionId: 'session-2',
      previousInPlaceResumeSessionId: 'session-1',
      madeMeaningfulProgress: false,
    }),
    'resume-in-place',
  )
})

test('manual recovery is unchanged for providers with a lossless fork and for cards without a session', () => {
  for (const provider of ['claude', 'codex'] as const) {
    assert.equal(
      resolveManualRecoveryPlan({
        provider,
        resumeSessionId: 'session-1',
        previousInPlaceResumeSessionId: undefined,
        madeMeaningfulProgress: false,
      }),
      'checkpoint-or-fresh',
    )
  }
  for (const resumeSessionId of [undefined, '', '   ']) {
    assert.equal(
      resolveManualRecoveryPlan({
        provider: 'gemini',
        resumeSessionId,
        previousInPlaceResumeSessionId: undefined,
        madeMeaningfulProgress: false,
      }),
      'checkpoint-or-fresh',
    )
  }
})

test('the lossless-fork capability list matches what the server fork actually supports', async () => {
  assert.equal(providerSupportsLosslessSessionFork('claude'), true)
  assert.equal(providerSupportsLosslessSessionFork('codex'), true)
  assert.equal(providerSupportsLosslessSessionFork('gemini'), false)
  // 服务端对不支持的 provider 按契约返回 null；两边必须是同一张表。
  assert.equal(
    await forkProviderSession({
      provider: 'gemini',
      workspacePath: 'D:/demo',
      sessionId: 'session-1',
      forkPoint: { content: 'hello', createdAt: '2026-11-26T00:00:00.000Z' },
    }),
    null,
  )
})

test('messages that never reach the model are flagged so the chat can grey them out', () => {
  const base = { id: 'm', createdAt: '2026-11-18T00:00:00.000Z' }
  // CLI 把报错回显成 assistant 文本 / 重连占位 / 应用自己的普通系统提示：都不进上下文
  assert.equal(isContextExcludedMessage({ ...base, role: 'assistant', content: 'API Error: Request rejected (429)' }), true)
  assert.equal(isContextExcludedMessage({ ...base, role: 'assistant', content: 'Reconnecting... 2/5' }), true)
  assert.equal(isContextExcludedMessage({ ...base, role: 'system', content: 'boom' }), true)
  // 真实回复、用户消息、带 kind 的结构化条目（工具/命令/耗时）都在上下文里或另有样式
  assert.equal(isContextExcludedMessage({ ...base, role: 'assistant', content: 'done' }), false)
  assert.equal(isContextExcludedMessage({ ...base, role: 'user', content: 'API Error: 我贴给你看的报错' }), false)
  assert.equal(
    isContextExcludedMessage({ ...base, role: 'system', content: '12s', meta: { kind: 'run-duration' } } as never),
    false,
  )
})
