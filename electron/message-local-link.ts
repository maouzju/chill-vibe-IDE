import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const explicitSchemePattern = /^[a-z][a-z\d+.-]*:/i
const windowsDrivePathPattern = /^[a-z]:[\\/]/i
const slashPrefixedWindowsDrivePathPattern = /^\/[a-z]:[\\/]/i
const fileLineAnchorPattern = /#L\d+(?:C\d+)?$/i

const isFileUrl = (href: string) => /^file:\/\//i.test(href)

const normalizePortablePath = (value: string) =>
  windowsDrivePathPattern.test(value) ? path.win32.normalize(value) : path.normalize(value)

const resolvePortablePath = (basePath: string, relativePath: string) =>
  windowsDrivePathPattern.test(basePath)
    ? path.win32.resolve(basePath, relativePath)
    : path.resolve(basePath, relativePath)

const fileUrlToPortablePath = (href: string) => {
  const url = new URL(href)
  const decodedPathname = decodeURIComponent(url.pathname)

  if (slashPrefixedWindowsDrivePathPattern.test(decodedPathname)) {
    return path.win32.normalize(decodedPathname.slice(1))
  }

  return path.normalize(fileURLToPath(url))
}

const normalizeMessageLocalHref = (href: string) => {
  const withoutFileAnchor = href.replace(fileLineAnchorPattern, '')

  if (slashPrefixedWindowsDrivePathPattern.test(withoutFileAnchor)) {
    return withoutFileAnchor.slice(1)
  }

  return withoutFileAnchor
}

export const isLocalMessageLinkHref = (href: string | null | undefined) => {
  const value = href?.trim() ?? ''

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return false
  }

  if (isFileUrl(value)) {
    return true
  }

  if (windowsDrivePathPattern.test(value)) {
    return true
  }

  return !explicitSchemePattern.test(value)
}

export const resolveMessageLocalLinkTarget = (
  href: string,
  workspacePath?: string,
) => {
  const trimmedHref = normalizeMessageLocalHref(href.trim())

  if (!isLocalMessageLinkHref(trimmedHref)) {
    return null
  }

  if (isFileUrl(trimmedHref)) {
    return fileUrlToPortablePath(trimmedHref)
  }

  if (windowsDrivePathPattern.test(trimmedHref)) {
    return path.win32.normalize(trimmedHref)
  }

  if (path.isAbsolute(trimmedHref)) {
    return normalizePortablePath(trimmedHref)
  }

  const basePath = workspacePath?.trim() ? workspacePath : process.cwd()
  return resolvePortablePath(basePath, trimmedHref)
}
