// 后端搬进 utilityProcess 之后，两类"在同进程下天经地义"的调用点会静默变形。
// 这里把它们收成两个纯函数，主进程的调用点统一走这里 —— 也才钉得住守卫测试
// （pitfall 248：对源码文本做正则断言证明不了任何运行时行为）。

// 症状 — 窗口每 ~20 秒消失一次（2026-07-26，一条畸形 wake-timer 队列条目）。
// 根因 — `ipcMain.on` 没有回复通道，handler 里逃出来的任何东西都变成
//   uncaughtException 并终结整个 app；`main.ts` 因此包了一圈同步 try/catch。
//   后端搬进 utilityProcess 后 `queueStateSave` 由**同步抛**变成 **rejected
//   Promise**，那圈 try/catch 一行都命中不到，成为死代码 —— 同一个症状会原样复发。
// 为什么不能只写 `void backend.queueStateSave(state).catch(...)` — 那样就漏掉了
//   代理层自身的同步抛（端口已关 / 载荷不可克隆时 sendRequest 之前就会抛），
//   两种形态必须由同一个出口兜住。
export const runBackendSideEffect = (
  operation: () => unknown,
  onError: (error: Error) => void,
): void => {
  const report = (error: unknown) => {
    onError(error instanceof Error ? error : new Error(String(error)))
  }

  let result: unknown
  try {
    result = operation()
  } catch (error) {
    report(error)
    return
  }

  if (typeof (result as { then?: unknown } | null)?.then === 'function') {
    void Promise.resolve(result).catch(report)
  }
}

// 症状 — 白噪音音频读回来是"看起来对但用不了"的数据。
// 根因 — `backend.readAmbientAudioBuffer` 声明返回 `Buffer`，而结构化克隆只搬字节、
//   不保原型：跨进程之后到手的是普通 `Uint8Array`，`Buffer.isBuffer()` 为 false，
//   任何按 Buffer 用的下游都会走到另一套实现上。
// 为什么不用 `Buffer.from(view.buffer)` — 克隆可以把一个 subarray 还原成"整块
//   ArrayBuffer + 偏移"，那样会多带出窗口前后的字节。必须尊重 byteOffset/byteLength。
export const toAmbientAudioBuffer = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }

  throw new Error('The ambient audio payload did not cross the backend boundary as bytes.')
}
