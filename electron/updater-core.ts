// Pure updater logic — no Electron dependencies so this module is importable from tests.

export type UpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  assetUrl?: string
  releaseNotes?: string
  htmlUrl?: string
  error?: string
}

export type GitHubAsset = {
  name: string
  browser_download_url: string
}

export type GitHubRelease = {
  tag_name: string
  body?: string
  html_url?: string
  assets: GitHubAsset[]
}

export type DownloadedAssetKind = 'zip' | 'installer' | 'disk-image' | 'unknown'
export type DownloadedAssetStrategy = 'replace-app-folder' | 'shell-open'

export const GITHUB_REPO = 'maouzju/chill-vibe-IDE'
export const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
export const CHECK_TIMEOUT_MS = 15_000

export function parseVersionTag(tag: string): string | null {
  const stripped = tag.startsWith('v') ? tag.slice(1) : tag
  return /^\d+\.\d+\.\d+$/.test(stripped) ? stripped : null
}

export function isNewerVersion(latest: string, current: string): boolean {
  const [a1, a2, a3] = latest.split('.').map(Number)
  const [b1, b2, b3] = current.split('.').map(Number)
  if (a1 !== b1) return a1 > b1
  if (a2 !== b2) return a2 > b2
  return a3 > b3
}

export function classifyDownloadedAsset(assetPath: string): DownloadedAssetKind {
  const normalized = assetPath.trim().toLowerCase()

  if (normalized.endsWith('.zip')) {
    return 'zip'
  }

  if (normalized.endsWith('.exe') || normalized.endsWith('.msi')) {
    return 'installer'
  }

  if (normalized.endsWith('.dmg') || normalized.endsWith('.pkg')) {
    return 'disk-image'
  }

  return 'unknown'
}

export function resolveDownloadedAssetStrategy(
  platform: string,
  assetPath: string,
): DownloadedAssetStrategy {
  const kind = classifyDownloadedAsset(assetPath)

  if (platform === 'win32' && kind === 'zip') {
    return 'replace-app-folder'
  }

  return 'shell-open'
}

const getPlatformDisplayName = (platform: string) => {
  if (platform === 'win32') {
    return 'Windows'
  }

  if (platform === 'darwin') {
    return 'macOS'
  }

  if (platform === 'linux') {
    return 'Linux'
  }

  return platform
}

const buildMissingAssetError = (assets: GitHubAsset[], platform: string) => {
  if (assets.length === 0) {
    return 'Latest release does not have any downloadable assets yet.'
  }

  return `No downloadable ${getPlatformDisplayName(platform)} asset found in the latest release.`
}

const findAssetByExtension = (assets: GitHubAsset[], extensions: string[]) => {
  const normalizedExtensions = extensions.map((value) => value.toLowerCase())

  return (
    assets.find((asset) => {
      const name = asset.name.trim().toLowerCase()
      return normalizedExtensions.some((extension) => name.endsWith(extension))
    }) ?? null
  )
}

export function selectPlatformAsset(
  assets: GitHubAsset[],
  platform: string,
): GitHubAsset | null {
  if (platform === 'win32') {
    return findAssetByExtension(assets, ['.zip', '.exe'])
  }
  if (platform === 'darwin') {
    return findAssetByExtension(assets, ['.dmg'])
  }
  return null
}

export function parseReleaseResponse(
  release: GitHubRelease,
  currentVersion: string,
  platform: string,
): UpdateCheckResult {
  const latestVersion = parseVersionTag(release.tag_name)

  if (!latestVersion) {
    return { hasUpdate: false, currentVersion, error: `Invalid release tag: ${release.tag_name}` }
  }

  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { hasUpdate: false, currentVersion, latestVersion }
  }

  const asset = selectPlatformAsset(release.assets, platform)

  if (!asset) {
    return {
      hasUpdate: true,
      currentVersion,
      latestVersion,
      htmlUrl: release.html_url,
      releaseNotes: release.body,
      error: buildMissingAssetError(release.assets, platform),
    }
  }

  return {
    hasUpdate: true,
    currentVersion,
    latestVersion,
    assetUrl: asset.browser_download_url,
    htmlUrl: release.html_url,
    releaseNotes: release.body,
  }
}
