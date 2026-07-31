import { resolveOpenableFilePath } from './structured-file-paths'

export type MessageFileTarget = {
  openPath: string
  line: number | undefined
}

type FileReferenceCandidate = {
  path: string
  line: number | undefined
}

// Extension whitelist is the main guard against turning ordinary inline code into
// a click target. Without it `writeFileSync`, `--frozen-lockfile`, and `v1.5` all
// read as "has a dot / looks pathy" and the whole transcript becomes clickable.
const FILE_REFERENCE_EXTENSIONS = new Set([
  'astro', 'bash', 'bat', 'c', 'cc', 'cfg', 'cjs', 'clj', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv',
  'cxx', 'dart', 'diff', 'dockerfile', 'ejs', 'elm', 'env', 'erb', 'ex', 'exs', 'fish', 'fs', 'gd',
  'gitignore', 'go', 'gradle', 'graphql', 'gql', 'h', 'handlebars', 'hbs', 'hpp', 'hs', 'htm',
  'html', 'ini', 'ipynb', 'java', 'jl', 'js', 'json', 'json5', 'jsonc', 'jsx', 'kt', 'kts', 'less',
  'lock', 'log', 'lua', 'm', 'md', 'mdx', 'mjs', 'mts', 'nix', 'patch', 'php', 'pl', 'plist',
  'properties', 'proto', 'ps1', 'psm1', 'py', 'pyi', 'r', 'rb', 'rs', 'rst', 'sass', 'sbt', 'scala',
  'scm', 'scss', 'sh', 'sql', 'styl', 'svelte', 'svg', 'swift', 'tf', 'toml', 'ts', 'tsx', 'txt',
  'vue', 'xml', 'yaml', 'yml', 'zig', 'zsh',
])

// Images are openable too — App.openTextEditorTab routes them to ImageEditorCard.
const IMAGE_REFERENCE_EXTENSIONS = new Set([
  'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'webp',
])

const GITHUB_LINE_ANCHOR = /#L(\d+)(?:C\d+)?$/i
const TRAILING_LINE_COLUMN = /:(\d+):(\d+)$/
const TRAILING_LINE = /:(\d+)$/
const WINDOWS_DRIVE_ROOT = /^[a-z]:[\\/]?$/i
const WINDOWS_DRIVE_PREFIX = /^[a-z]:[\\/]/i
const EXPLICIT_SCHEME = /^[a-z][a-z\d+.-]*:/i
const FILE_URL = /^file:\/\//i

const stripLineAnchor = (value: string): FileReferenceCandidate => {
  const github = value.match(GITHUB_LINE_ANCHOR)
  if (github) {
    return { path: value.slice(0, github.index), line: Number(github[1]) }
  }

  for (const pattern of [TRAILING_LINE_COLUMN, TRAILING_LINE]) {
    const match = value.match(pattern)
    if (!match) {
      continue
    }

    const head = value.slice(0, match.index)
    // `D:` alone is a drive root, not a path with a line number.
    if (head && !WINDOWS_DRIVE_ROOT.test(head)) {
      return { path: head, line: Number(match[1]) }
    }
  }

  return { path: value, line: undefined }
}

const hasNonFileScheme = (value: string) => {
  if (WINDOWS_DRIVE_PREFIX.test(value) || FILE_URL.test(value)) {
    return false
  }

  return EXPLICIT_SCHEME.test(value)
}

const getExtension = (value: string) => {
  const lastSegment = value.split(/[\\/]/).pop() ?? ''
  const dotIndex = lastSegment.lastIndexOf('.')

  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) {
    return null
  }

  return lastSegment.slice(dotIndex + 1).toLowerCase()
}

export const isOpenableFileExtension = (extension: string | null) =>
  extension !== null
  && (FILE_REFERENCE_EXTENSIONS.has(extension) || IMAGE_REFERENCE_EXTENSIONS.has(extension))

// Inline code is not an explicit "this is a link" signal from the model, so the
// bar is deliberately high: no whitespace, no scheme, and a whitelisted extension.
export const parseFileReferenceCandidate = (raw: string): FileReferenceCandidate | null => {
  const trimmed = raw.trim()

  if (!trimmed || trimmed.length > 260 || /\s/.test(trimmed)) {
    return null
  }

  const { path, line } = stripLineAnchor(trimmed)

  if (!path || WINDOWS_DRIVE_ROOT.test(path) || hasNonFileScheme(path)) {
    return null
  }

  if (!isOpenableFileExtension(getExtension(path))) {
    return null
  }

  return { path, line }
}

export const resolveMessageFileTarget = (
  workspacePath: string | undefined,
  raw: string,
): MessageFileTarget | null => {
  const candidate = parseFileReferenceCandidate(raw)

  if (!candidate) {
    return null
  }

  const openPath = resolveOpenableFilePath(workspacePath ?? '', candidate.path)

  return openPath ? { openPath, line: candidate.line } : null
}

// A markdown link destination IS an explicit authoring signal, so the extension
// whitelist and the no-whitespace rule are dropped. Only obvious directories and
// non-file schemes are rejected.
const resolveMessageLinkFileTargetInternal = (
  workspacePath: string | undefined,
  raw: string,
): MessageFileTarget | null => {
  const trimmed = raw.trim()

  if (!trimmed || trimmed.length > 1024 || trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    return null
  }

  const { path, line } = stripLineAnchor(trimmed)

  if (!path || WINDOWS_DRIVE_ROOT.test(path) || hasNonFileScheme(path)) {
    return null
  }

  if (getExtension(path) === null) {
    return null
  }

  const openPath = resolveOpenableFilePath(workspacePath ?? '', path)

  return openPath ? { openPath, line } : null
}

export const resolveMessageLinkFileTarget = resolveMessageLinkFileTargetInternal

export const isLocalMessageLinkHref = (href: string | null | undefined) => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return false
  }

  if (FILE_URL.test(value) || WINDOWS_DRIVE_PREFIX.test(value)) {
    return true
  }

  return !EXPLICIT_SCHEME.test(value)
}

export const isExternalMessageLinkHref = (href: string | null | undefined) => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return false
  }

  return !isLocalMessageLinkHref(value) && EXPLICIT_SCHEME.test(value)
}

export type MessageLinkAction =
  | { kind: 'none' }
  | { kind: 'reveal'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'open-editor'; openPath: string; line: number | undefined }

// Ordering matters: the Alt escape hatch has to win before the editor branch, or
// "just show me the folder" becomes unreachable once a workspace is configured.
export const resolveMessageLinkAction = ({
  href,
  workspacePath,
  canOpenInEditor,
  altKey = false,
}: {
  href: string | null | undefined
  workspacePath: string | undefined
  canOpenInEditor: boolean
  altKey?: boolean
}): MessageLinkAction => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return { kind: 'none' }
  }

  if (isLocalMessageLinkHref(value)) {
    if (!altKey && canOpenInEditor) {
      const target = resolveMessageLinkFileTargetInternal(workspacePath, value)

      if (target) {
        return { kind: 'open-editor', openPath: target.openPath, line: target.line }
      }
    }

    return { kind: 'reveal', href: value }
  }

  if (isExternalMessageLinkHref(value)) {
    return { kind: 'external', href: value }
  }

  return { kind: 'none' }
}
