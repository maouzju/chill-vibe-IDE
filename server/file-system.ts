import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  FileCreateRequest,
  FileDeleteRequest,
  FileEntry,
  FileListRequest,
  FileMoveRequest,
  FileReadRequest,
  FileRenameRequest,
  FileWriteRequest,
  FileReadResponse,
  FileSearchEntry,
  FileSearchRequest,
} from '../shared/schema.js'

const extensionLanguageMap: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.json': 'json',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.txt': 'plaintext',
  '.env': 'dotenv',
  '.gitignore': 'ignore',
  '.dockerignore': 'ignore',
  '.dockerfile': 'dockerfile',
}

const getLanguageFromPath = (filePath: string): string => {
  const basename = path.basename(filePath).toLowerCase()
  if (basename === 'dockerfile') return 'dockerfile'
  if (basename === 'makefile') return 'makefile'
  return extensionLanguageMap[path.extname(filePath).toLowerCase()] ?? 'plaintext'
}

const ignoredFileTreeEntryNames = new Set(['.git', 'node_modules'])

const isIgnoredTreeEntry = (name: string) => ignoredFileTreeEntryNames.has(name.toLowerCase())

const compareTreeEntries = (
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean },
) => {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }

  return a.name.localeCompare(b.name)
}

const normalizeSearchValue = (value: string) => value.replace(/\\/g, '/').trim().toLowerCase()

const normalizeEntryName = (value: string) => {
  const trimmed = value.trim()

  if (!trimmed) {
    throw new Error('Entry name is required.')
  }

  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Entry names must not contain path separators.')
  }

  return trimmed
}

const joinRelativePath = (parentRelativePath: string, name: string) =>
  parentRelativePath ? `${parentRelativePath}/${name}` : name

const normalizeRelativePath = (value: string) =>
  value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '')

const scoreSearchEntry = (entry: FileSearchEntry, normalizedQuery: string) => {
  const normalizedName = normalizeSearchValue(entry.name)
  const normalizedPath = normalizeSearchValue(entry.path)

  if (normalizedName === normalizedQuery) {
    return 0
  }

  if (normalizedName.startsWith(normalizedQuery)) {
    return 1
  }

  if (normalizedName.includes(normalizedQuery)) {
    return 2
  }

  if (normalizedPath.includes(`/${normalizedQuery}`)) {
    return 3
  }

  return 4
}

export const ensureWithinWorkspace = (workspacePath: string, relativePath: string): string => {
  const resolved = path.resolve(workspacePath, relativePath)
  const normalizedWorkspace = path.resolve(workspacePath)
  if (resolved.startsWith(normalizedWorkspace + path.sep) || resolved === normalizedWorkspace) {
    return resolved
  }

  // Allow reading files under the user's ~/.claude/ directory (e.g. plan files)
  const claudeDir = path.join(os.homedir(), '.claude')
  if (resolved.startsWith(claudeDir + path.sep)) {
    return resolved
  }

  throw new Error('Path traversal is not allowed.')
}

export const listFiles = async (request: FileListRequest): Promise<{ entries: FileEntry[] }> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const dirEntries = await readdir(targetPath, { withFileTypes: true })

  const entries: FileEntry[] = dirEntries
    .filter((entry) => !isIgnoredTreeEntry(entry.name))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
    .sort(compareTreeEntries)

  return { entries }
}

export const searchWorkspaceFiles = async (
  request: FileSearchRequest,
): Promise<{ entries: FileSearchEntry[] }> => {
  const workspacePath = ensureWithinWorkspace(request.workspacePath, '')
  const query = normalizeSearchValue(request.query)

  if (query.length === 0) {
    return { entries: [] }
  }

  const entries: FileSearchEntry[] = []

  const walkDirectory = async (directoryPath: string, relativeDirectory = ''): Promise<void> => {
    const dirEntries = await readdir(directoryPath, { withFileTypes: true })
    const visibleEntries = dirEntries
      .filter((entry) => !isIgnoredTreeEntry(entry.name))
      .map((entry) => ({
        entry,
        isDirectory: entry.isDirectory(),
      }))
      .sort((a, b) =>
        compareTreeEntries(
          { name: a.entry.name, isDirectory: a.isDirectory },
          { name: b.entry.name, isDirectory: b.isDirectory },
        ),
      )

    for (const { entry, isDirectory } of visibleEntries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name

      if (isDirectory) {
        await walkDirectory(path.join(directoryPath, entry.name), relativePath)
        continue
      }

      const searchTarget = normalizeSearchValue(`${entry.name} ${relativePath}`)

      if (!searchTarget.includes(query)) {
        continue
      }

      entries.push({
        path: relativePath,
        name: entry.name,
        isDirectory: false,
      })
    }
  }

  await walkDirectory(workspacePath)
  entries.sort((a, b) => {
    const scoreDifference = scoreSearchEntry(a, query) - scoreSearchEntry(b, query)

    if (scoreDifference !== 0) {
      return scoreDifference
    }

    return a.path.localeCompare(b.path)
  })

  return { entries: entries.slice(0, request.limit) }
}

export const createWorkspaceFile = async (request: FileCreateRequest): Promise<void> => {
  const entryName = normalizeEntryName(request.name)
  const parentPath = ensureWithinWorkspace(request.workspacePath, request.parentRelativePath)
  const parentStats = await stat(parentPath)

  if (!parentStats.isDirectory()) {
    throw new Error('Parent path must be a directory.')
  }

  const targetPath = ensureWithinWorkspace(
    request.workspacePath,
    joinRelativePath(request.parentRelativePath, entryName),
  )
  await writeFile(targetPath, '', { encoding: 'utf8', flag: 'wx' })
}

export const createWorkspaceDirectory = async (request: FileCreateRequest): Promise<void> => {
  const entryName = normalizeEntryName(request.name)
  const parentPath = ensureWithinWorkspace(request.workspacePath, request.parentRelativePath)
  const parentStats = await stat(parentPath)

  if (!parentStats.isDirectory()) {
    throw new Error('Parent path must be a directory.')
  }

  const targetPath = ensureWithinWorkspace(
    request.workspacePath,
    joinRelativePath(request.parentRelativePath, entryName),
  )
  await mkdir(targetPath)
}

export const renameWorkspaceEntry = async (request: FileRenameRequest): Promise<void> => {
  const nextName = normalizeEntryName(request.nextName)
  const sourcePath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const sourceStats = await stat(sourcePath)

  if (!sourceStats) {
    throw new Error('Path not found.')
  }

  const relativeParentPath = path.dirname(request.relativePath)
  const targetRelativePath =
    relativeParentPath === '.'
      ? nextName
      : joinRelativePath(relativeParentPath.replace(/\\/g, '/'), nextName)
  const targetPath = ensureWithinWorkspace(request.workspacePath, targetRelativePath)
  const targetStats = await stat(targetPath).catch(() => null)

  if (targetStats) {
    throw new Error('Target already exists.')
  }

  await rename(sourcePath, targetPath)
}

export const moveWorkspaceEntry = async (request: FileMoveRequest): Promise<void> => {
  const sourceRelativePath = normalizeRelativePath(request.relativePath)
  const destinationParentRelativePath = normalizeRelativePath(request.destinationParentRelativePath)
  const sourcePath = ensureWithinWorkspace(request.workspacePath, sourceRelativePath)
  const sourceStats = await stat(sourcePath)

  if (!sourceStats) {
    throw new Error('Path not found.')
  }

  const sourceParentRelativePath = path.posix.dirname(sourceRelativePath) === '.'
    ? ''
    : path.posix.dirname(sourceRelativePath)

  if (destinationParentRelativePath === sourceParentRelativePath) {
    return
  }

  if (
    sourceStats.isDirectory() &&
    (
      destinationParentRelativePath === sourceRelativePath ||
      destinationParentRelativePath.startsWith(`${sourceRelativePath}/`)
    )
  ) {
    throw new Error('Cannot move a directory into its own descendant.')
  }

  const destinationParentPath = ensureWithinWorkspace(request.workspacePath, destinationParentRelativePath)
  const destinationParentStats = await stat(destinationParentPath)

  if (!destinationParentStats.isDirectory()) {
    throw new Error('Destination parent path must be a directory.')
  }

  const entryName = path.posix.basename(sourceRelativePath)
  const targetRelativePath = joinRelativePath(destinationParentRelativePath, entryName)
  const targetPath = ensureWithinWorkspace(request.workspacePath, targetRelativePath)
  const targetStats = await stat(targetPath).catch(() => null)

  if (targetStats) {
    throw new Error('Target already exists.')
  }

  await rename(sourcePath, targetPath)
}

export const deleteWorkspaceEntry = async (request: FileDeleteRequest): Promise<void> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  await stat(targetPath)
  await rm(targetPath, { recursive: true, force: false })
}

export const readWorkspaceFile = async (request: FileReadRequest): Promise<FileReadResponse> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const content = await readFile(targetPath, 'utf8')
  return { content, language: getLanguageFromPath(request.relativePath) }
}

export const writeWorkspaceFile = async (request: FileWriteRequest): Promise<void> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  await writeFile(targetPath, request.content, 'utf8')
}
