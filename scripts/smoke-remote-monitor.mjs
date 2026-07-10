// 一次性端到端烟测：走真实 desktop backend（真实 state 快照 + 真实 qrcode 生成
// + 真实 0.0.0.0 监听），验证手机页面/快照/SSE/停止全链路。用 tsx 跑：
//   node --import tsx scripts/smoke-remote-monitor.mjs
import assert from 'node:assert/strict'

import { createDesktopBackend } from '../electron/backend.ts'

const backend = createDesktopBackend()

const info = await backend.startRemoteMonitor()
console.log('[smoke] started:', { url: info.url, port: info.port, lanFallback: info.lanFallback })
assert.match(info.qrDataUrl, /^data:image\/png;base64,/, 'QR data URL should be a PNG')

const base = `http://127.0.0.1:${info.port}`

const page = await fetch(`${base}/?token=${info.token}`)
assert.equal(page.status, 200)
assert.match(await page.text(), /Chill Vibe/)

const snapshot = await fetch(`${base}/api/snapshot?token=${info.token}`)
assert.equal(snapshot.status, 200)
const snapshotBody = await snapshot.json()
assert.ok(Array.isArray(snapshotBody.columns), 'snapshot should expose columns')
console.log('[smoke] snapshot columns:', snapshotBody.columns.length)

const unauthorized = await fetch(`${base}/api/snapshot`)
assert.equal(unauthorized.status, 401)

const sse = await fetch(`${base}/api/events?token=${info.token}`)
assert.equal(sse.status, 200)
assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/)
await sse.body.cancel()

// V2: 写命令端点——本脚本未注入 dispatchRemoteCommand，应精确落在 503 分支。
const action = await fetch(`${base}/api/actions?token=${info.token}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'stop-stream', cardId: 'card-x' }),
})
assert.equal(action.status, 503)
const badAction = await fetch(`${base}/api/actions?token=${info.token}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'nope' }),
})
assert.equal(badAction.status, 400)

const status = backend.fetchRemoteMonitorStatus()
assert.equal(status.running, true)

await backend.stopRemoteMonitor()
assert.equal(backend.fetchRemoteMonitorStatus().running, false)
await assert.rejects(fetch(`${base}/api/snapshot?token=${info.token}`))

console.log('[smoke] remote monitor end-to-end smoke passed ✔')
// 不调用 backend.dispose()：resilient proxy 等兄弟服务的 native handle 在
// process.exit 竞争下会触发 libuv 断言；smoke 只关心 monitor 生命周期。
process.exit(0)
