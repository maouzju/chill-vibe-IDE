const fileUrlPattern = /^file:\/\//i
const slashPrefixedWindowsDrivePattern = /^\/[a-z]:\//i
const windowsDrivePattern = /^[a-z]:\//i

const stripFileLineAnchor = (value: string) => value.replace(/#L\d+(?:C\d+)?$/i, '')

const normalizeFileUrl = (value: string) => {
  if (!fileUrlPattern.test(value)) {
    return value
  }

  try {
    const url = new URL(value)

    if (url.protocol !== 'file:') {
      return value
    }

    return decodeURIComponent(url.pathname)
  } catch {
    return value
  }
}

const normalizePathInput = (value: string) => {
  let normalized = stripFileLineAnchor(normalizeFileUrl(value.trim())).replace(/\\/g, '/')

  if (slashPrefixedWindowsDrivePattern.test(normalized)) {
    normalized = normalized.slice(1)
  }

  return normalized
}

const getAbsolutePathRoot = (value: string) => {
  if (windowsDrivePattern.test(value)) {
    return {
      // Preserve the original casing — server-side whitelist checks compare the
      // resolved path against e.g. ~/.claude, and the rendered path stays readable.
      root: value.slice(0, 2),
      rest: value.slice(2),
    }
  }

  if (value.startsWith('//')) {
    const parts = value.split('/').filter(Boolean)

    if (parts.length < 2) {
      return null
    }

    return {
      root: `//${parts[0]}/${parts[1]}`,
      rest: `/${parts.slice(2).join('/')}`,
    }
  }

  if (value.startsWith('/')) {
    return {
      root: '/',
      rest: value,
    }
  }

  return null
}

const collapsePathSegments = (segments: string[]) => {
  const resolved: string[] = []

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (resolved.length === 0) {
        return null
      }

      resolved.pop()
      continue
    }

    resolved.push(segment)
  }

  return resolved
}

const normalizeRelativePath = (value: string) => {
  const normalized = normalizePathInput(value)

  if (!normalized || getAbsolutePathRoot(normalized)) {
    return null
  }

  const collapsed = collapsePathSegments(normalized.split('/'))

  return collapsed && collapsed.length > 0 ? collapsed.join('/') : null
}

const normalizeAbsolutePath = (value: string) => {
  const normalized = normalizePathInput(value)
  const absoluteRoot = normalized ? getAbsolutePathRoot(normalized) : null

  if (!absoluteRoot) {
    return null
  }

  const collapsed = collapsePathSegments(absoluteRoot.rest.split('/'))

  if (collapsed === null) {
    return null
  }

  if (absoluteRoot.root === '/') {
    return collapsed.length > 0 ? `/${collapsed.join('/')}` : '/'
  }

  return collapsed.length > 0 ? `${absoluteRoot.root}/${collapsed.join('/')}` : absoluteRoot.root
}

export const resolveWorkspaceRelativeFilePath = (workspacePath: string, candidatePath: string) => {
  if (!workspacePath.trim()) {
    return null
  }

  const relativePath = normalizeRelativePath(candidatePath)

  if (relativePath) {
    return relativePath
  }

  const normalizedWorkspace = normalizeAbsolutePath(workspacePath)
  const normalizedCandidate = normalizeAbsolutePath(candidatePath)

  if (!normalizedWorkspace || !normalizedCandidate) {
    return null
  }

  const normalizedWorkspaceKey = normalizedWorkspace.toLowerCase()
  const normalizedCandidateKey = normalizedCandidate.toLowerCase()

  if (normalizedCandidateKey === normalizedWorkspaceKey) {
    return null
  }

  const workspacePrefix = `${normalizedWorkspace}/`
  const workspacePrefixKey = `${normalizedWorkspaceKey}/`

  if (!normalizedCandidateKey.startsWith(workspacePrefixKey)) {
    return null
  }

  return normalizeRelativePath(normalizedCandidate.slice(workspacePrefix.length))
}

// Like resolveWorkspaceRelativeFilePath, but out-of-workspace absolute paths stay
// openable as absolute paths — the server-side workspace/agent-home whitelist is
// the final gate on whether the file can actually be read.
export const resolveOpenableFilePath = (workspacePath: string, candidatePath: string) => {
  const relativePath = resolveWorkspaceRelativeFilePath(workspacePath, candidatePath)

  if (relativePath) {
    return relativePath
  }

  const normalizedCandidate = normalizeAbsolutePath(candidatePath)

  if (!normalizedCandidate) {
    return null
  }

  const normalizedWorkspace = workspacePath.trim() ? normalizeAbsolutePath(workspacePath) : null

  if (normalizedWorkspace && normalizedCandidate.toLowerCase() === normalizedWorkspace.toLowerCase()) {
    return null
  }

  return normalizedCandidate
}
