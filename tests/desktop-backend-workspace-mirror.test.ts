import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDesktopBackend } from '../electron/backend.ts'
import {
  createWorkspaceAdminRuntime,
  stopWorkspaceAdminBridge,
} from '../server/automation-board-session.ts'
import {
  workspaceAdminMcpServerName,
  workspaceAdminMcpTokenEnvKey,
  workspaceAdminMcpUrlEnvKey,
} from '../server/automation-board-runtime.ts'
import { getStickyNoteWorkspaceDirectory } from '../server/sticky-note-store.ts'
import { workspaceSessionMirrorSchema, type ChatRequest } from '../shared/schema.ts'

// 这个文件钉的是"主进程不再自己读写 server 的模块级单例"这条契约。
// 判据刻意选成**端到端**：镜像从 backend 对象写进去，再由真正的超管桥接
// （懒启动的回环 HTTP 服务，它拿的是 automation-board-session 自己的
// readWorkspaceSessionMirror / readWorkspaceSessionTranscript）读回来。
// 只断言"backend.publish 之后模块导出的 read 能读到"是不够的 —— 那两个
// 读函数将来会跑在后端那一侧，必须证明写和读落在同一份 Map 上。

const columnId = 'col-mirror-bridge'

const buildMirror = () =>
  workspaceSessionMirrorSchema.parse({
    columnId,
    workspacePath: 'D:\\Git\\chill-vibe',
    generatedAt: '2026-08-12T02:42:00.000Z',
    boardCardIds: ['board-1'],
    sessions: [
      {
        cardId: 'item-running',
        title: '登录页',
        provider: 'codex',
        model: 'gpt-5.4',
        status: 'streaming',
        board: {
          boardCardId: 'board-1',
          lane: 'running',
          requirement: '把登录页的错误提示改成中文',
          startedAt: '2026-08-12T01:30:00.000Z',
        },
        lastActivityAt: '2026-08-12T02:41:00.000Z',
        lastMessagePreview: '正在读 login.ts…',
        messageCount: 12,
        recentEntries: [
          { id: 'm-1', role: 'assistant', content: '已经改完中文提示', createdAt: '2026-08-12T02:41:00.000Z' },
        ],
      },
    ],
  })

const adminChatRequest = {
  provider: 'claude',
  model: 'claude-opus-5',
  prompt: 'hello',
  language: 'zh-CN',
  attachments: [],
  adminAccess: { columnId, selfCardId: 'card-admin' },
} as unknown as ChatRequest

// 症状：三条用例全绿，文件级却是 ✖ —— stdout 里只有一行
//   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`，
//   整个 node --test 子进程被 libuv abort 掉，`pnpm test` 因此永远红。
// 根因：2026-08-12 实测（Node v24.11.1 / Windows）—— 与本仓库代码无关，
//   `--test-force-exit`（scripts/run-node-tests.mjs 默认开）会在最后一条用例结束后
//   立刻 process.exit()，而 undici 的 keep-alive socket 此时正处于 closing 中途。
//   最小复现只需「裸 http.createServer + 连续两次 fetch + --test-force-exit」，
//   不 import 本仓库任何模块；一次 fetch 不触发，两次起必现。
// 为什么不能换写法：`Connection: close` 头、读干净响应体、关掉 undici 全局
//   dispatcher、以及不停桥接直接退出，四种都试过，全都照样崩 —— 只有绕开 undici
//   才行。所以这里用 node:http + `agent: false`（每请求一条连接、退出前已关闭）。
const getJson = (url: string, token: string) =>
  new Promise<{ status: number; json: () => unknown }>((resolve, reject) => {
    const request = http.get(
      url,
      { agent: false, headers: { Authorization: `Bearer ${token}` } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            json: () => JSON.parse(body) as unknown,
          })
        })
      },
    )
    request.on('error', reject)
  })

const startBridge = async () => {
  const runtime = await createWorkspaceAdminRuntime(adminChatRequest)
  assert.ok(runtime, 'admin runtime should exist for a turn with adminAccess')
  const env = runtime.claudeMcpConfig.mcpServers[workspaceAdminMcpServerName].env
  const url = env[workspaceAdminMcpUrlEnvKey]
  const token = env[workspaceAdminMcpTokenEnvKey]
  assert.ok(url && token, 'bridge should expose a loopback url + token')

  return { get: (pathAndQuery: string) => getJson(`${url}${pathAndQuery}`, token) }
}

test('the desktop backend publishes into the same mirror state the admin bridge reads', async (t) => {
  const backend = createDesktopBackend({})
  t.after(async () => {
    await stopWorkspaceAdminBridge()
  })

  const bridge = await startBridge()

  assert.equal(await bridge.get(`/workspace?columnId=${columnId}`).then((r) => r.status), 404)

  assert.equal(backend.publishWorkspaceSessionMirror(buildMirror()), true)

  const published = await bridge.get(`/workspace?columnId=${columnId}`)
  assert.equal(published.status, 200)
  const body = (await published.json()) as { mirror: { columnId: string; sessions: unknown[] } }
  assert.equal(body.mirror.columnId, columnId)
  assert.equal(body.mirror.sessions.length, 1)

  // 转录读取走的是同一份 Map 的另一个入口（readWorkspaceSessionTranscript）。
  const transcript = await bridge.get('/session?cardId=item-running')
  assert.equal(transcript.status, 200)
  const transcriptBody = (await transcript.json()) as { entries: Array<{ content: string }> }
  assert.deepEqual(
    transcriptBody.entries.map((entry) => entry.content),
    ['已经改完中文提示'],
  )

  backend.forgetWorkspaceSessionMirror(columnId)

  assert.equal(await bridge.get(`/workspace?columnId=${columnId}`).then((r) => r.status), 404)
  assert.equal(await bridge.get('/session?cardId=item-running').then((r) => r.status), 404)
})

test('the desktop backend rejects a malformed mirror instead of storing it', async (t) => {
  const backend = createDesktopBackend({})
  t.after(async () => {
    await stopWorkspaceAdminBridge()
  })

  // 与旧的主进程 handler 行为等价：safeParse 失败回 false，绝不抛给 IPC。
  assert.equal(backend.publishWorkspaceSessionMirror({ columnId: '' }), false)
  assert.equal(backend.publishWorkspaceSessionMirror(null), false)

  const bridge = await startBridge()
  assert.equal(await bridge.get(`/workspace?columnId=${columnId}`).then((r) => r.status), 404)

  // 空/非字符串 columnId 不该炸，也不该删掉别的列。
  assert.equal(backend.publishWorkspaceSessionMirror(buildMirror()), true)
  backend.forgetWorkspaceSessionMirror('   ')
  backend.forgetWorkspaceSessionMirror(42 as unknown as string)
  assert.equal(await bridge.get(`/workspace?columnId=${columnId}`).then((r) => r.status), 200)
})

test('the desktop backend owns the sticky-note workspace directory resolution', async () => {
  // `desktop:reveal-sticky-note-location` 曾在主进程里第二次 import
  // server/sticky-note-store（它有模块级 workspaceQueues 写序列化 Map，且这条
  // 路径会真的 mkdir + 写 workspace.json）。主进程只该留 shell.openPath。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-backend-sticky-'))
  const previousDataDir = process.env.CHILL_VIBE_DATA_DIR
  process.env.CHILL_VIBE_DATA_DIR = dataDir

  try {
    const backend = createDesktopBackend({})
    const workspacePath = path.join(dataDir, 'workspace')
    const directory = await backend.ensureStickyNoteWorkspaceDirectory(workspacePath)

    assert.equal(directory, getStickyNoteWorkspaceDirectory(workspacePath, dataDir))
    assert.equal(fs.existsSync(directory), true)
    assert.equal(fs.existsSync(path.join(directory, 'workspace.json')), true)
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.CHILL_VIBE_DATA_DIR
    } else {
      process.env.CHILL_VIBE_DATA_DIR = previousDataDir
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
