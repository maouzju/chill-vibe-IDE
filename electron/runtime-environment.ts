import path from 'node:path'

const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/

const normalizePortableAbsolutePath = (value: string) =>
  windowsAbsolutePathPattern.test(value) ? path.win32.normalize(value) : path.resolve(value)

export function resolveDesktopRuntimeKind({ isDev }: { isDev: boolean }) {
  return isDev ? 'dev' : 'release'
}

export function resolveDesktopDataDir({
  isDev,
  projectRoot,
  userDataPath,
  configuredDataDir,
  allowConfiguredOverride,
}: {
  isDev: boolean
  projectRoot: string
  userDataPath: string
  configuredDataDir?: string | null
  allowConfiguredOverride: boolean
}) {
  const normalizedConfiguredDataDir = configuredDataDir?.trim()

  if (allowConfiguredOverride && normalizedConfiguredDataDir) {
    return normalizePortableAbsolutePath(normalizedConfiguredDataDir)
  }

  return isDev
    ? path.join(projectRoot, '.chill-vibe')
    : path.join(userDataPath, 'data')
}

export function resolveDesktopRuntimeProfilePaths({
  isDev,
  projectRoot,
}: {
  isDev: boolean
  projectRoot: string
}) {
  if (!isDev) {
    return null
  }

  const runtimeRoot = path.join(projectRoot, '.chill-vibe', 'electron-dev')
  return {
    userData: path.join(runtimeRoot, 'user-data'),
    sessionData: path.join(runtimeRoot, 'session-data'),
  }
}

export function resolveDesktopWorkingDirectory({
  isDev,
  moduleDir,
}: {
  isDev: boolean
  moduleDir: string
}) {
  return isDev ? path.resolve(moduleDir, '../..') : null
}
