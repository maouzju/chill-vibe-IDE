import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  buildSpecFileSet,
  buildSpecSeedDocuments,
  type EnsureSpecDocumentsResult,
} from '../shared/spec-first.js'
import type { AppLanguage } from '../shared/schema.js'
import { ensureWithinWorkspace } from './file-system.js'

export type EnsureSpecDocumentsRequest = {
  workspacePath: string
  title: string
  language: AppLanguage
}

const fileExists = async (filePath: string) =>
  Boolean(await stat(filePath).catch(() => null))

export const ensureSpecDocuments = async ({
  workspacePath,
  title,
  language,
}: EnsureSpecDocumentsRequest): Promise<EnsureSpecDocumentsResult> => {
  const files = buildSpecFileSet(title)
  const docs = buildSpecSeedDocuments(files.title, language)
  const folderPath = ensureWithinWorkspace(workspacePath, files.folderRelativePath)
  await mkdir(folderPath, { recursive: true })

  const entries = [
    [files.requirementsPath, docs.requirements],
    [files.designPath, docs.design],
    [files.tasksPath, docs.tasks],
  ] as const
  const created: string[] = []
  const existing: string[] = []

  for (const [relativePath, content] of entries) {
    const absolutePath = ensureWithinWorkspace(workspacePath, relativePath)

    if (await fileExists(absolutePath)) {
      existing.push(relativePath)
      continue
    }

    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, { encoding: 'utf8', flag: 'wx' })
    created.push(relativePath)
  }

  return {
    ...files,
    created,
    existing,
  }
}
