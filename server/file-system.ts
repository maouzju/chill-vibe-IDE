import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { decodeWithEncoding, detectAndDecode, encodeForWrite, sniffBomEncoding } from './file-encoding.js'

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
  FileWriteResponse,
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

export type ClipboardCopyInvocation = { command: string; args: string[] }

type ClipboardCopyRunner = (command: string, args: string[]) => Promise<{ exitCode: number; stderr: string }>

type ClipboardCopyOptions = {
  platform?: NodeJS.Platform
  run?: ClipboardCopyRunner
}

const runClipboardCommand: ClipboardCopyRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stderr }))
  })

// pwsh 7 dropped Set-Clipboard -LiteralPath, so target Windows PowerShell 5.1 explicitly.
const resolveWindowsPowerShellPath = (): string => {
  const systemRoot = process.env.SystemRoot ?? process.env.windir
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
}

const buildClipboardCopyInvocation = (platform: NodeJS.Platform, filePath: string): ClipboardCopyInvocation => {
  if (platform === 'win32') {
    const escapedPath = filePath.replace(/'/g, "''")
    return {
      command: resolveWindowsPowerShellPath(),
      args: ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${escapedPath}'`],
    }
  }

  if (platform === 'darwin') {
    const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return {
      command: 'osascript',
      args: ['-e', `set the clipboard to (POSIX file "${escapedPath}")`],
    }
  }

  throw new Error(`Copying files to the clipboard is not supported on ${platform}.`)
}

/** Places the file itself (not its text) on the OS clipboard, like Ctrl+C in Explorer/Finder. */
export const copyWorkspaceFileToClipboard = async (
  request: FileReadRequest,
  options: ClipboardCopyOptions = {},
): Promise<void> => {
  const filePath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const stats = await stat(filePath)

  if (!stats.isFile()) {
    throw new Error('The selected path is not a file.')
  }

  const invocation = buildClipboardCopyInvocation(options.platform ?? process.platform, filePath)
  const run = options.run ?? runClipboardCommand
  const result = await run(invocation.command, invocation.args)

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim()
    throw new Error(detail.length > 0 ? `Unable to copy file to clipboard: ${detail}` : 'Unable to copy file to clipboard.')
  }
}

// Reads above the hard limit never load content; between the thresholds the editor degrades.
const FILE_READ_HARD_LIMIT_BYTES = 10 * 1024 * 1024
const FILE_READ_LARGE_THRESHOLD_BYTES = 1.5 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192

export const computeFileRevision = (content: string): string =>
  createHash('sha1').update(content, 'utf8').digest('hex')

const looksBinary = (buffer: Buffer): boolean => {
  const sniffLength = Math.min(buffer.length, BINARY_SNIFF_BYTES)
  for (let index = 0; index < sniffLength; index += 1) {
    if (buffer[index] === 0) {
      return true
    }
  }
  return false
}

export class FileRevisionConflictError extends Error {
  readonly conflict = true

  constructor() {
    super('File changed on disk since it was loaded.')
    this.name = 'FileRevisionConflictError'
  }
}

export const readWorkspaceFile = async (request: FileReadRequest): Promise<FileReadResponse> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const language = getLanguageFromPath(request.relativePath)
  const stats = await stat(targetPath)

  if (stats.size > FILE_READ_HARD_LIMIT_BYTES) {
    return { content: '', language, size: stats.size, tooLarge: true }
  }

  const buffer = await readFile(targetPath)

  // A BOM proves text — UTF-16 ASCII would otherwise trip the NUL sniffer.
  if (!sniffBomEncoding(buffer) && looksBinary(buffer)) {
    return { content: '', language, size: stats.size, binary: true }
  }

  const { content, encoding } = detectAndDecode(buffer)
  const response: FileReadResponse = {
    content,
    language,
    size: stats.size,
    encoding,
    revision: computeFileRevision(content),
  }

  if (stats.size > FILE_READ_LARGE_THRESHOLD_BYTES) {
    response.large = true
  }

  return response
}

export const writeWorkspaceFile = async (request: FileWriteRequest): Promise<FileWriteResponse> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)

  if (request.expectedRevision) {
    const currentBuffer = await readFile(targetPath).catch((error: NodeJS.ErrnoException) => {
      // A deleted file cannot lose anyone's edits, so restoring it is not a conflict.
      if (error?.code === 'ENOENT') {
        return null
      }
      throw error
    })

    if (currentBuffer !== null) {
      // Decode with the same encoding the read used, or non-UTF-8 files would
      // always look conflicted against their own revision.
      const currentContent = decodeWithEncoding(currentBuffer, request.encoding)
      if (computeFileRevision(currentContent) !== request.expectedRevision) {
        throw new FileRevisionConflictError()
      }
    }
  }

  await writeFile(targetPath, encodeForWrite(request.content, request.encoding))
  return { revision: computeFileRevision(request.content) }
}
