import { attachmentProtocolScheme } from './attachment-protocol.js'

export const localImageProtocolScheme = 'chill-vibe-local-image'

const explicitSchemePattern = /^[a-z][a-z\d+.-]*:/i
const fileUrlPattern = /^file:\/\//i
const windowsDrivePathPattern = /^[a-z]:[\\/]/i

const imageFileExtensionPattern = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

export const hasImageFileExtension = (value: string) =>
  imageFileExtensionPattern.test(value.trim())

export const getLocalImageProtocolUrl = (src: string, workspacePath?: string) => {
  const params = new URLSearchParams({ src })
  const workspace = workspacePath?.trim()

  if (workspace) {
    params.set('workspace', workspace)
  }

  return `${localImageProtocolScheme}://local/?${params.toString()}`
}

// Markdown image sources written by the model are usually plain local paths
// (workspace-relative or absolute). The renderer cannot load those directly, so
// anything that points at the local filesystem is routed through the privileged
// local-image protocol; genuine web/data/attachment sources pass through.
export const resolveMarkdownImageSrc = (
  src: string | null | undefined,
  workspacePath?: string,
): string | undefined => {
  const value = src?.trim()

  if (!value || value.startsWith('#') || value.startsWith('?')) {
    return undefined
  }

  if (
    value.toLowerCase().startsWith(`${localImageProtocolScheme}:`)
    || value.toLowerCase().startsWith(`${attachmentProtocolScheme}:`)
  ) {
    return value
  }

  if (fileUrlPattern.test(value) || windowsDrivePathPattern.test(value)) {
    return getLocalImageProtocolUrl(value, workspacePath)
  }

  if (explicitSchemePattern.test(value)) {
    return value
  }

  return getLocalImageProtocolUrl(value, workspacePath)
}
