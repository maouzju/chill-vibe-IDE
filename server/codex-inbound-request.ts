// Codex app-server 的**反向请求**（它主动向我们发起、带 `id` 期待响应的调用）。
//
// 症状 — 旧实现遇到任何这类请求就 finishWithError，整条流当场判死，回合结束。
//   于是 `approvalPolicy: 'on-request'` 从来不能用：Codex 一发审批请求，用户看到
//   的是回合失败而不是审批提示。
// 根因 — 那段代码把"我们没实现这个方法"当成了"这个回合完了"。这两件事无关：
//   JSON-RPC 对未识别方法的约定是回 -32601，调用方自己决定降级还是放弃。
// 为什么不按方法名分类处理 — 我们手上**没有任何真实入站请求的实证**。按猜测实现
//   审批语义，等于把 pitfall #289/#291 再犯一次（自造一个对面不认的值）。先按规范
//   拒绝并把方法名记进日志，等日志里真的出现了它，再拿实证去实现。

export const jsonRpcMethodNotFoundCode = -32601

export const buildCodexInboundRequestRejection = (
  id: unknown,
  method: string,
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: jsonRpcMethodNotFoundCode,
    message: `Chill Vibe does not implement "${method}".`,
  },
})
