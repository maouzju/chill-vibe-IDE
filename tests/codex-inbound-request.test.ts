import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexInboundRequestRejection,
  jsonRpcMethodNotFoundCode,
} from '../server/codex-inbound-request.ts'

// 症状 — Codex app-server 一旦发来任何带 `id` 的入站请求（审批、elicitation、
//   将来任何新增的反向调用），providers.ts 直接 finishWithError 把**整条流判死**，
//   回合当场结束。于是 `approvalPolicy: 'on-request'` 事实上永远不可用。
// 这里钉住的是替代行为：按 JSON-RPC 规范回一条 error 响应，让对面自己决定怎么办，
// 我们的回合继续跑。

test('an unsupported inbound request gets a spec-shaped JSON-RPC error response', () => {
  const response = buildCodexInboundRequestRejection(7, 'execCommandApproval')

  assert.equal(response.jsonrpc, '2.0')
  assert.equal(response.id, 7)
  const error = response.error as { code: number; message: string }
  // -32601 Method not found —— JSON-RPC 与 ACP 对"未识别请求"的统一约定。
  assert.equal(error.code, jsonRpcMethodNotFoundCode)
})

test('the rejection names the method so the log can identify it later', () => {
  const response = buildCodexInboundRequestRejection('abc-1', 'session/request_permission')
  const error = response.error as { message: string }

  // 方法名必须进正文：我们还没有任何真实入站请求的实证，日志里的方法名
  // 就是下次能把它实现对的唯一线索（pitfall #289/#291 的教训）。
  assert.match(error.message, /session\/request_permission/)
})

test('the inbound request id is echoed verbatim, whatever its type', () => {
  // JSON-RPC 的 id 可以是 string 或 number；转换类型会让对面认不出这条响应。
  assert.equal(buildCodexInboundRequestRejection('str-id', 'x').id, 'str-id')
  assert.equal(buildCodexInboundRequestRejection(42, 'x').id, 42)
  assert.equal(buildCodexInboundRequestRejection(0, 'x').id, 0)
})
