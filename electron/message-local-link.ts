import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import type { shell } from 'electron'
import { stat } from 'node:fs/promises'

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

type RevealMessageLocalLinkShellAdapter = Pick<typeof shell, 'openPath' | 'showItemInFolder'>
type RevealMessageLocalLinkStats = Pick<Awaited<ReturnType<typeof stat>>, 'isDirectory'>
type RevealMessageLocalLinkStatPath = (
  targetPath: string,
) => Promise<RevealMessageLocalLinkStats>

type RevealMessageLocalLinkTargetOptions = {
  platform?: NodeJS.Platform
  shellAdapter: RevealMessageLocalLinkShellAdapter
  statPath?: RevealMessageLocalLinkStatPath
}

export const revealMessageLocalLinkTarget = async (
  targetPath: string,
  options: RevealMessageLocalLinkTargetOptions,
) => {
  const statPath = options.statPath ?? stat
  const targetStats = await statPath(targetPath).catch(() => null)

  if (!targetStats) {
    throw new Error(`Path not found: ${targetPath}`)
  }

  const platform = options.platform ?? process.platform

  if (platform === 'win32') {
    options.shellAdapter.showItemInFolder(targetPath)
    return
  }

  if (targetStats.isDirectory()) {
    const openError = await options.shellAdapter.openPath(targetPath)

    if (openError) {
      throw new Error(openError)
    }

    return
  }

  options.shellAdapter.showItemInFolder(targetPath)
}
