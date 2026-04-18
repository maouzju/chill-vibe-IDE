import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AppLanguage, ChatRequest } from '../shared/schema.js'
import { getAppDataDir, getAttachmentsDir } from './app-paths.js'

export const archiveRecallMcpServerName = 'chill_vibe_archive'
export const archiveRecallContextPathEnvKey = 'CHILL_VIBE_ARCHIVE_RECALL_FILE'
export const archiveRecallAttachmentsDirEnvKey = 'CHILL_VIBE_ARCHIVE_RECALL_ATTACHMENTS_DIR'

export type ArchiveRecallRuntimeOverrides = {
  runtimeArgs: string[]
  contextFilePath: string
  cleanup: () => Promise<void>
}

const formatTomlString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const formatTomlStringArray = (values: string[]) =>
  `[${values.map((value) => formatTomlString(value)).join(', ')}]`

const getArchiveRecallMcpScriptPath = () =>
  fileURLToPath(new URL('./archive-recall-mcp.js', import.meta.url))

const getArchiveRecallSnapshotDir = () => path.join(getAppDataDir(), 'archive-recall')

const getArchiveRecallCommandEnv = () => {
  const envEntries: Record<string, string> = {
    [archiveRecallAttachmentsDirEnvKey]: getAttachmentsDir(),
  }

  if (process.versions.electron) {
    envEntries.ELECTRON_RUN_AS_NODE = '1'
  }

  return envEntries
}

export const createArchiveRecallRuntimeOverrides = async (
  request: ChatRequest,
): Promise<ArchiveRecallRuntimeOverrides | null> => {
  if (request.provider !== 'codex') {
    return null
  }

  const archiveRecall = request.archiveRecall
  if (!archiveRecall || archiveRecall.messages.length === 0) {
    return null
  }

  const snapshotDir = getArchiveRecallSnapshotDir()
  await mkdir(snapshotDir, { recursive: true })

  const contextFilePath = path.join(snapshotDir, `${crypto.randomUUID()}.json`)
  await writeFile(contextFilePath, JSON.stringify(archiveRecall), 'utf8')

  const runtimeArgs = [
    '-c',
    `mcp_servers.${archiveRecallMcpServerName}.command=${formatTomlString(process.execPath)}`,
    '-c',
    `mcp_servers.${archiveRecallMcpServerName}.args=${formatTomlStringArray([
      getArchiveRecallMcpScriptPath(),
    ])}`,
  ]

  const envEntries = {
    ...getArchiveRecallCommandEnv(),
    [archiveRecallContextPathEnvKey]: contextFilePath,
  }

  for (const [key, value] of Object.entries(envEntries)) {
    runtimeArgs.push(
      '-c',
      `mcp_servers.${archiveRecallMcpServerName}.env.${key}=${formatTomlString(value)}`,
    )
  }

  return {
    runtimeArgs,
    contextFilePath,
    cleanup: async () => {
      await rm(contextFilePath, { force: true })
    },
  }
}

export const getCodexArchiveRecallInstruction = (language: AppLanguage) => {
  void language
  return 'If the user refers to earlier compacted history, hidden screenshots, or logs from before the latest /compact boundary, first use search_compacted_history and then read_compacted_history for the matching archived item. Do not say an older attachment is unavailable until you have checked those tools. Use them only when relevant.'
}
