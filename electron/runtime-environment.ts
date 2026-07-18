import path from 'node:path'

const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/

const normalizePortableAbsolutePath = (value: string) =>
  windowsAbsolutePathPattern.test(value) ? path.win32.normalize(value) : path.resolve(value)

export function resolveDesktopRuntimeKind({ isDev }: { isDev: boolean }) {
  return isDev ? 'dev' : 'release'
}

export function resolveHardwareAccelerationEnabled({
  platform,
  enableOverride,
  disableOverride,
}: {
  platform: NodeJS.Platform
  enableOverride?: string | null
  disableOverride?: string | null
}) {
  if (disableOverride === '1') {
    return false
  }

  if (enableOverride === '1') {
    return true
  }

  // Windows is the only platform where real-world evidence showed the legacy
  // software path saturating SwiftShader during multi-pane streaming. Keep the
  // historical fallback elsewhere until those platforms get equivalent soak.
  return platform === 'win32'
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
  configuredProfileRoot,
}: {
  isDev: boolean
  projectRoot: string
  configuredProfileRoot?: string | null
}) {
  if (!isDev) {
    return null
  }

  const normalizedConfiguredProfileRoot = configuredProfileRoot?.trim()
  const runtimeRoot = normalizedConfiguredProfileRoot
    ? normalizePortableAbsolutePath(normalizedConfiguredProfileRoot)
    : path.join(projectRoot, '.chill-vibe', 'electron-dev')
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
