import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { createDefaultState } from '../shared/default-state.ts'

const sidecarFileName = (entryId: string) => `${Buffer.from(entryId, 'utf8').toString('base64url')}.json`

test('web server startup does not hydrate archived sidecars before listening', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-web-lightweight-'))
  const workspacePath = path.join(dataDir, 'workspace')
  const state = createDefaultState(workspacePath)
  state.sessionHistory = [{
    id: 'web-index-preview',
    title: 'Web startup preview',
    sessionId: 'web-index-session',
    provider: 'codex',
    model: 'gpt-5.5',
    workspacePath,
    messageCount: 1,
    messagesPreview: true,
    messages: [],
    archivedAt: '2026-08-06T01:00:00.000Z',
  }]
  await writeFile(path.join(dataDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  const sidecarDir = path.join(dataDir, 'session-history')
  await mkdir(sidecarDir, { recursive: true })
  await writeFile(
    path.join(sidecarDir, sidecarFileName('web-unrelated-archive')),
    `${JSON.stringify({
      id: 'web-unrelated-archive',
      title: 'Unrelated web archive',
      sessionId: 'web-unrelated-session',
      provider: 'codex',
      model: 'gpt-5.5',
      workspacePath,
      messages: [{
        id: 'web-unrelated-message',
        role: 'user',
        content: 'Server startup must not read this body.',
        createdAt: '2026-08-06T01:00:00.000Z',
      }],
      archivedAt: '2026-08-06T01:00:00.000Z',
    }, null, 2)}\n`,
    'utf8',
  )

  const spyPath = pathToFileURL(path.join(process.cwd(), 'tests', 'fixtures', 'session-history-read-spy.mjs')).href
  const env = { ...process.env }
  delete env.CHILL_VIBE_RUNTIME_KIND
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CHROME_CRASHPAD_PIPE_NAME
  env.CHILL_VIBE_DATA_DIR = dataDir
  env.CHILL_VIBE_DEFAULT_WORKSPACE = workspacePath
  env.PORT = '0'

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', spyPath, 'server/index.ts'],
    {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  )
  const sidecarAccesses: unknown[] = []
  let spyReady = false
  let stdout = ''
  let stderr = ''
  const childStdout = child.stdout
  const childStderr = child.stderr
  if (!childStdout || !childStderr) {
    child.kill()
    throw new Error('Web server test child did not expose stdout/stderr pipes.')
  }
  childStdout.setEncoding('utf8')
  childStderr.setEncoding('utf8')
  childStdout.on('data', (chunk: string) => { stdout += chunk })
  childStderr.on('data', (chunk: string) => { stderr += chunk })
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const type = (message as { type?: unknown }).type
    if (type === 'session-history-spy-ready') spyReady = true
    if (type === 'session-history-fs-access') sidecarAccesses.push(message)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Web server did not become ready.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }, 15_000)
      const poll = setInterval(() => {
        if (stdout.includes('Chill Vibe IDE server listening on')) {
          clearTimeout(timeout)
          clearInterval(poll)
          resolve()
        }
      }, 50)
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        clearInterval(poll)
        reject(new Error(`Web server exited before readiness (${code ?? signal}).\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    })

    assert.equal(spyReady, true, 'filesystem observer should be installed before server startup')
    assert.deepEqual(sidecarAccesses, [])
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dataDir, { recursive: true, force: true })
  }
})
