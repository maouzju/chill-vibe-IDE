import {
  hasImageFileExtension,
} from '../shared/local-image-protocol.js'
import { resolveMessageLocalLinkTarget } from './message-local-link.js'

// Resolves a chill-vibe-local-image:// request URL to an on-disk image path.
// Returns null when the request is malformed, escapes the image-extension
// allowlist, or cannot be resolved to a local file path.
export const resolveLocalImageRequestTarget = (requestUrl: string): string | null => {
  let url: URL

  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }

  const src = url.searchParams.get('src')?.trim()

  if (!src) {
    return null
  }

  const workspace = url.searchParams.get('workspace')?.trim() || undefined
  const target = resolveMessageLocalLinkTarget(src, workspace)

  if (!target || !hasImageFileExtension(target)) {
    return null
  }

  return target
}
