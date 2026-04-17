import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'

import { createDefaultState } from '../shared/default-state.js'
import {
  attachmentUploadRequestSchema,
  appStateSchema,
  ccSwitchImportRequestSchema,
  externalHistoryListRequestSchema,
  externalSessionLoadRequestSchema,
  internalSessionHistoryLoadRequestSchema,
  chatRequestSchema,
  gitCommitRequestSchema,
  gitPullRequestSchema,
  gitStageRequestSchema,
  fileCreateRequestSchema,
  fileDeleteRequestSchema,
  fileListRequestSchema,
  fileMoveRequestSchema,
  fileReadRequestSchema,
  fileRenameRequestSchema,
  fileSearchRequestSchema,
  specEnsureRequestSchema,
  fileWriteRequestSchema,
  slashCommandRequestSchema,
  workspaceValidationRequestSchema,
} from '../shared/schema.js'
import { resolveImageAttachmentPath, storeImageAttachment } from './attachments.js'
import { getDefaultWorkspacePath } from './app-paths.js'
import { importCcSwitchProfiles } from './cc-switch-import.js'
import { listExternalSessions, loadExternalSession } from './external-history.js'
import {
  createWorkspaceDirectory,
  createWorkspaceFile,
  deleteWorkspaceEntry,
  listFiles,
  moveWorkspaceEntry,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from './file-system.js'
import { ensureSpecDocuments } from './spec-first.js'
import { ChatManager } from './chat-manager.js'
import {
  commitGitWorkspace,
  initGitWorkspace,
  inspectGitWorkspace,
  pullGitWorkspace,
  setGitWorkspaceStage,
} from './git-workspace.js'
import { inspectOnboardingStatus } from './onboarding-status.js'
import { getProviderSlashCommands, getProviderStatuses, validateWorkspacePath } from './providers.js'
import { resilientProxyPool } from './resilient-proxy.js'
import { SetupManager } from './setup-manager.js'
import { loadSessionHistoryEntry, loadState, loadStateForRenderer, queueSaveState, resetState, saveState } from './state-store.js'
import { initServerCrashLogger, writeServerLog } from './crash-logger.js'

initServerCrashLogger()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.resolve(__dirname, '../client')
const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST?.trim() || '127.0.0.1'
const isBuiltServer = __dirname.includes(`${path.sep}dist${path.sep}server`)
const defaultJsonParser = express.json({ limit: '25mb' })
const ccSwitchImportJsonParser = express.json({ limit: '100mb' })

const formatHttpUrl = (listenHost: string, listenPort: number) =>
  `http://${listenHost.includes(':') ? `[${listenHost}]` : listenHost}:${listenPort}`

const app = express()
const chatManager = new ChatManager()
const setupManager = new SetupManager()

app.disable('x-powered-by')
app.use((request, response, next) => {
  if (request.path === '/api/routing/import/cc-switch') {
    next()
    return
  }

  defaultJsonParser(request, response, next)
})

app.get('/api/state', async (_request, response) => {
  const { state } = await loadStateForRenderer()
  response.json(state)
})

app.get('/api/session-history/:entryId', async (request, response) => {
  const parsed = internalSessionHistoryLoadRequestSchema.safeParse({
    entryId: request.params.entryId,
  })

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid internal session history load request.' })
    return
  }

  try {
    response.json(await loadSessionHistoryEntry(parsed.data))
  } catch (error) {
    response.status(404).json({
      message: error instanceof Error ? error.message : 'Session history entry not found.',
    })
  }
})

app.put('/api/state', async (request, response) => {
  const parsed = appStateSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid IDE state payload.' })
    return
  }

  const state = await saveState(parsed.data)
  response.json(state)
})

app.post('/api/state/snapshot', async (request, response) => {
  const parsed = appStateSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid IDE state payload.' })
    return
  }

  void queueSaveState(parsed.data)
  response.status(204).end()
})

app.post('/api/state/reset', async (_request, response) => {
  const state = await resetState()
  response.json(state)
})

app.get('/api/providers', async (_request, response) => {
  response.json(await getProviderStatuses())
})

app.get('/api/setup/status', (_request, response) => {
  response.json(setupManager.getStatus())
})

app.get('/api/onboarding/status', async (_request, response) => {
  response.json(await inspectOnboardingStatus())
})

app.post('/api/setup/run', (_request, response) => {
  response.status(202).json(setupManager.start())
})

app.post('/api/slash-commands', async (request, response) => {
  const parsed = slashCommandRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid slash command request.' })
    return
  }

  response.json(await getProviderSlashCommands(parsed.data))
})

app.post('/api/workspace/validate', async (request, response) => {
  const parsed = workspaceValidationRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ valid: false, reason: 'A path is required.' })
    return
  }

  response.json(await validateWorkspacePath(parsed.data.path))
})

app.get('/api/git/status', async (request, response) => {
  const parsed = gitPullRequestSchema.safeParse({
    workspacePath: request.query.workspacePath,
  })

  if (!parsed.success) {
    response.status(400).json({ message: 'A workspace path is required.' })
    return
  }

  try {
    response.json(await inspectGitWorkspace(parsed.data.workspacePath))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to inspect the Git workspace.',
    })
  }
})

app.post('/api/git/stage', async (request, response) => {
  const parsed = gitStageRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid Git staging request.' })
    return
  }

  try {
    response.json(await setGitWorkspaceStage(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to update the staged files.',
    })
  }
})

app.post('/api/git/init', async (request, response) => {
  const parsed = gitPullRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid Git init request.' })
    return
  }

  try {
    response.json(await initGitWorkspace(parsed.data.workspacePath))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to create the Git repository.',
    })
  }
})

app.post('/api/git/commit', async (request, response) => {
  const parsed = gitCommitRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid Git commit request.' })
    return
  }

  try {
    response.json(await commitGitWorkspace(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to create the commit.',
    })
  }
})

app.post('/api/git/pull', async (request, response) => {
  const parsed = gitPullRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid Git pull request.' })
    return
  }

  try {
    response.json(await pullGitWorkspace(parsed.data.workspacePath))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to pull the latest changes.',
    })
  }
})

app.post('/api/files/list', async (request, response) => {
  const parsed = fileListRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file list request.' })
    return
  }

  try {
    response.json(await listFiles(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to list files.',
    })
  }
})

app.post('/api/files/search', async (request, response) => {
  const parsed = fileSearchRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file search request.' })
    return
  }

  try {
    response.json(await searchWorkspaceFiles(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to search files.',
    })
  }
})

app.post('/api/files/create', async (request, response) => {
  const parsed = fileCreateRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file create request.' })
    return
  }

  try {
    await createWorkspaceFile(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to create file.',
    })
  }
})

app.post('/api/files/create-directory', async (request, response) => {
  const parsed = fileCreateRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid directory create request.' })
    return
  }

  try {
    await createWorkspaceDirectory(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to create directory.',
    })
  }
})

app.post('/api/files/rename', async (request, response) => {
  const parsed = fileRenameRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file rename request.' })
    return
  }

  try {
    await renameWorkspaceEntry(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to rename entry.',
    })
  }
})

app.post('/api/files/move', async (request, response) => {
  const parsed = fileMoveRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file move request.' })
    return
  }

  try {
    await moveWorkspaceEntry(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to move entry.',
    })
  }
})

app.post('/api/files/delete', async (request, response) => {
  const parsed = fileDeleteRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file delete request.' })
    return
  }

  try {
    await deleteWorkspaceEntry(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to delete entry.',
    })
  }
})

app.post('/api/files/read', async (request, response) => {
  const parsed = fileReadRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file read request.' })
    return
  }

  try {
    response.json(await readWorkspaceFile(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to read file.',
    })
  }
})

app.post('/api/files/write', async (request, response) => {
  const parsed = fileWriteRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid file write request.' })
    return
  }

  try {
    await writeWorkspaceFile(parsed.data)
    response.status(204).end()
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to write file.',
    })
  }
})

app.post('/api/specs/ensure', async (request, response) => {
  const parsed = specEnsureRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid SPEC scaffold request.' })
    return
  }

  try {
    const result = await ensureSpecDocuments(parsed.data)
    response.json(result)
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to create SPEC docs.',
    })
  }
})

app.post('/api/attachments', async (request, response) => {
  const parsed = attachmentUploadRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid image attachment payload.' })
    return
  }

  try {
    response.status(201).json(await storeImageAttachment(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to store the pasted image.',
    })
  }
})

app.post('/api/routing/import/cc-switch', ccSwitchImportJsonParser, async (request, response) => {
  const parsed = ccSwitchImportRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid cc-switch import request.' })
    return
  }

  try {
    response.json(await importCcSwitchProfiles(parsed.data))
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : 'Unable to import cc-switch routing settings.',
    })
  }
})

app.get('/api/external-history', async (request, response) => {
  const parsed = externalHistoryListRequestSchema.safeParse({
    workspacePath: request.query.workspacePath,
  })

  if (!parsed.success) {
    response.status(400).json({ message: 'A valid workspacePath query parameter is required.' })
    return
  }

  try {
    response.json(await listExternalSessions(parsed.data))
  } catch (error) {
    response.status(500).json({
      message: error instanceof Error ? error.message : 'Unable to list external history.',
    })
  }
})

app.get('/api/external-history/:sessionId', async (request, response) => {
  const parsed = externalSessionLoadRequestSchema.safeParse({
    provider: request.query.provider,
    sessionId: request.params.sessionId,
    workspacePath: request.query.workspacePath,
  })

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid external session load request.' })
    return
  }

  try {
    response.json(await loadExternalSession(parsed.data))
  } catch (error) {
    response.status(404).json({
      message: error instanceof Error ? error.message : 'External session not found.',
    })
  }
})

app.get('/api/attachments/:attachmentId', async (request, response) => {
  try {
    response.sendFile(await resolveImageAttachmentPath(request.params.attachmentId))
  } catch {
    response.status(404).json({ message: 'Attachment not found.' })
  }
})

app.post('/api/chat/message', async (request, response) => {
  const parsed = chatRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({ message: 'Invalid chat request.' })
    return
  }

  const workspaceCheck = await validateWorkspacePath(parsed.data.workspacePath, parsed.data.language)
  if (!workspaceCheck.valid) {
    response.status(400).json({ message: workspaceCheck.reason })
    return
  }

  try {
    const streamId = chatManager.createStream(parsed.data)
    response.status(201).json({ streamId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to create chat stream.'
    response.status(409).json({ message })
  }
})

app.get('/api/chat/stream/:streamId', (request, response) => {
  chatManager.attach(request.params.streamId, request, response)
})

app.post('/api/chat/stop/:streamId', (request, response) => {
  const stopped = chatManager.stop(request.params.streamId)

  if (!stopped) {
    response.status(404).json({ message: 'Stream not found or already finished.' })
    return
  }

  response.json({ ok: true })
})

app.use(
  (
    error: Error & { status?: number; type?: string },
    request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next

    void writeServerLog('ERROR', `Express error: ${error.message}`, {
      path: request.path,
      method: request.method,
      stack: error.stack,
    })

    const status =
      typeof error.status === 'number' ? error.status : error.type === 'entity.too.large' ? 413 : 500
    const message =
      error.type === 'entity.too.large' && request.path === '/api/routing/import/cc-switch'
        ? 'The selected cc-switch export is too large. Use the default database import button or choose a smaller .sql export.'
        : error.type === 'entity.too.large'
          ? 'The submitted payload is too large.'
          : error.message || 'Unexpected server error.'

    response.status(status).json({
      message,
    })
  },
)

const startServer = async () => {
  const shouldServeClient = process.env.NODE_ENV === 'production' || isBuiltServer

  if (shouldServeClient) {
    app.use(express.static(clientDist))

    app.get('*', (_request, response) => {
      response.sendFile(path.join(clientDist, 'index.html'))
    })
  }

  app.listen(port, host, async () => {
    const state = await loadState().catch(() => createDefaultState(getDefaultWorkspacePath()))
    await saveState(state).catch(() => undefined)
    console.log(`Chill Vibe IDE server listening on ${formatHttpUrl(host, port)}`)
  })
}

void startServer()

const shutdown = () => {
  chatManager.closeAll()
  setupManager.dispose()
  void resilientProxyPool.dispose().finally(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
