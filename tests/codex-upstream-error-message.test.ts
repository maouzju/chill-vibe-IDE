import assert from 'node:assert/strict'
import test from 'node:test'

import {
  describeCodexUpstreamFailure,
  readCodexErrorNotification,
  summarizeProviderDiagnostics,
} from '../server/providers.js'

// 症状：2026-08-14 用户与两名同事报「codex 用不了」，卡片里只有一行原样的
//       `{"error":{"message":"unknown provider for model gpt-5.6-sol","type":"new_api_error",...}}`。
//       这串 JSON 既没被解析，`classifyLaunchErrorHint` 也一个关键词都匹配不上（里面没有
//       api key / 401 / unauthorized），于是 hint=undefined：不跳面板、不给建议、不可恢复。
// 根因：`unknown provider for model X` 是中转站（new-api 前端 + CLIProxyAPI 上游）说
//       「这个模型名在我这找不到能承接的渠道」。它既不是本机 CLI 的问题，也不是网络问题，
//       而我们把它和普通流错误一样原样打印，用户无从判断该改什么。
// 为什么不能只做 JSON 解析：解析出来的 `unknown provider for model gpt-5.6-sol` 对用户
//       依然是天书——真正缺的是「去哪改」。指引必须点名模型名和设置路径。
const unknownProviderBody =
  '{"error":{"message":"unknown provider for model gpt-5.6-sol","type":"new_api_error","param":"","code":"unknown_error"}}'

test('surfaces an actionable hint when the upstream does not serve the requested model', () => {
  const zh = describeCodexUpstreamFailure(unknownProviderBody, 'zh-CN')

  assert.ok(zh.message.includes('gpt-5.6-sol'), 'the unusable model name must be named')
  assert.ok(zh.message.includes('设置'), 'the message must point at where to change the model')
  assert.ok(
    zh.message.includes('unknown provider for model gpt-5.6-sol'),
    'the raw upstream text must stay available for diagnosis',
  )
  assert.equal(zh.hint, 'switch-config')
})

test('the model-unavailable guidance is localized', () => {
  const en = describeCodexUpstreamFailure(unknownProviderBody, 'en')

  assert.ok(en.message.includes('gpt-5.6-sol'))
  assert.ok(/settings/i.test(en.message), 'English guidance must point at Settings')
  assert.ok(!/[一-龥]/.test(en.message), 'English guidance must not leak Chinese text')
})

test('recognizes the other shapes upstreams use for the same failure', () => {
  for (const raw of [
    '{"error":{"message":"model_not_found","code":"model_not_found"}}',
    '{"error":{"message":"当前分组下对于模型 gpt-5.6-sol 无可用渠道"}}',
    '{"error":{"message":"The model `gpt-5.6-sol` does not exist or you do not have access to it."}}',
  ]) {
    const described = describeCodexUpstreamFailure(raw, 'zh-CN')
    assert.equal(described.hint, 'switch-config', `should classify: ${raw}`)
    assert.ok(described.message.includes('设置'), `should guide the user: ${raw}`)
  }
})

test('unwraps ordinary upstream JSON error bodies into their message', () => {
  const described = describeCodexUpstreamFailure(
    '{"error":{"message":"Insufficient credits","type":"billing_error"}}',
    'zh-CN',
  )

  assert.equal(described.message, 'Insufficient credits')
})

test('leaves plain-text errors untouched', () => {
  const described = describeCodexUpstreamFailure('stream disconnected before completion', 'zh-CN')

  assert.equal(described.message, 'stream disconnected before completion')
  assert.equal(described.hint, undefined)
})

// 长行过滤原本会把压成一行的 JSON 错误体整条丢掉，用户只剩「Codex 退出，状态码：1」。
test('keeps an over-long upstream JSON error body instead of dropping it silently', () => {
  const longBody = `{"error":{"message":"unknown provider for model gpt-5.6-sol","type":"new_api_error","param":"","code":"unknown_error","detail":"${'x'.repeat(400)}"}}`
  const summary = summarizeProviderDiagnostics(`${longBody}\nsome other line`)

  assert.ok(
    summary.includes('unknown provider for model gpt-5.6-sol'),
    'the JSON error body must survive the line-length filter',
  )
})

test('still drops over-long noise that is not an error body', () => {
  const summary = summarizeProviderDiagnostics(`${'n'.repeat(400)}\nkept line`)

  assert.equal(summary, 'kept line')
})

// 下面两条 payload 是 2026-08-14 用 scripts/probe-codex-app-server.mjs 对着真实上游
// （duckcoding，故意请求一个不存在的模型）抓下来的原文，不是手编的。codex 对 5xx 会自动
// 重连 5 次，每次发一条 willRetry:true 的通知，**真正的原因只在 additionalDetails 里**，
// `message` 只有一句「Reconnecting... N/5」；重试耗尽后才发 willRetry:false 的终态。
const retryingErrorParams = {
  error: {
    message: 'Reconnecting... 1/5',
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
    additionalDetails:
      'unexpected status 503 Service Unavailable: No available channel for model gpt-9.9-nonexistent under group CodeX-Sale (distributor) (request id: 2026081417041380756), url: https://api.duckcoding.ai/v1/responses',
  },
  willRetry: true,
  threadId: '01a0013b-f54c-70b3-8c23-67a764c983a3',
}

const terminalErrorParams = {
  error: {
    message:
      'unexpected status 503 Service Unavailable: No available channel for model gpt-9.9-nonexistent under group CodeX-Sale (distributor) (request id: 2026081417060930594), url: https://api.duckcoding.ai/v1/responses',
    codexErrorInfo: 'other',
    additionalDetails: null,
  },
  willRetry: false,
  threadId: '01a0013b-f54c-70b3-8c23-67a764c983a3',
}

test('a retrying codex error is not a terminal failure', () => {
  const notification = readCodexErrorNotification(retryingErrorParams)

  assert.ok(notification)
  assert.equal(notification.willRetry, true, 'willRetry must be honoured, not treated as terminal')
})

test('the real reason is read from additionalDetails, not the Reconnecting placeholder', () => {
  const notification = readCodexErrorNotification(retryingErrorParams)

  assert.ok(notification)
  assert.ok(
    notification.message.includes('No available channel for model gpt-9.9-nonexistent'),
    'additionalDetails carries the only useful text and must not be dropped',
  )
  assert.notEqual(notification.message, 'Reconnecting... 1/5')
})

test('the terminal codex error keeps its message and is actionable', () => {
  const notification = readCodexErrorNotification(terminalErrorParams)

  assert.ok(notification)
  assert.equal(notification.willRetry, false)

  const described = describeCodexUpstreamFailure(notification.message, 'zh-CN')
  assert.equal(described.hint, 'switch-config')
  assert.ok(described.message.includes('gpt-9.9-nonexistent'), 'the unusable model must be named')
  assert.ok(described.message.includes('设置'))
})
