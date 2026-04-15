import path from 'node:path'
import { fileURLToPath } from 'node:url'

const explicitSchemePattern = /^[a-z][a-z\d+.-]*:/i
const windowsDrivePathPattern = /^[a-z]:[\\/]/i
const slashPrefixedWindowsDrivePathPattern = /^\/[a-z]:[\\/]/i
const fileLineAnchorPattern = /#L\d+(?:C\d+)?$/i

const isFileUrl = (href: string) => /^file:\/\//i.test(href)

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
    return path.normalize(fileURLToPath(trimmedHref))
  }

  if (path.isAbsolute(trimmedHref)) {
    return path.normalize(trimmedHref)
  }

  const basePath = workspacePath?.trim() ? workspacePath : process.cwd()
  return path.resolve(basePath, trimmedHref)
}
