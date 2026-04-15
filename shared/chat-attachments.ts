import type { ChatMessage, ImageAttachment, Provider } from './schema.js'
import { getAttachmentProtocolUrl } from './attachment-protocol.js'

const imageAttachmentMetaKey = 'imageAttachments'

type AttachmentWindow = {
  electronAPI?: {
    getAttachmentUrl?: (attachmentId: string) => string
  }
}

export const providerSupportsImageAttachments = (provider: Provider) =>
  provider === 'codex' || provider === 'claude'

export const getChatMessageAttachments = (
  message: Pick<ChatMessage, 'meta'> | { meta?: Record<string, string> },
): ImageAttachment[] => {
  const raw = message.meta?.[imageAttachmentMetaKey]

  if (!raw) {
    return []
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter(
          (attachment): attachment is ImageAttachment =>
            typeof attachment === 'object' &&
            attachment !== null &&
            'id' in attachment &&
            'fileName' in attachment &&
            'mimeType' in attachment &&
            'sizeBytes' in attachment,
        )
      : []
  } catch {
    return []
  }
}

export const attachImagesToMessageMeta = (
  attachments: ImageAttachment[],
  meta?: ChatMessage['meta'],
): ChatMessage['meta'] | undefined => {
  if (attachments.length === 0) {
    return meta
  }

  return {
    ...(meta ?? {}),
    [imageAttachmentMetaKey]: JSON.stringify(attachments),
  }
}

export const getImageAttachmentUrl = (attachmentId: string) =>
  typeof globalThis === 'object' &&
  'window' in globalThis &&
  typeof (globalThis as typeof globalThis & { window?: AttachmentWindow }).window?.electronAPI
    ?.getAttachmentUrl === 'function'
    ? (globalThis as typeof globalThis & { window?: AttachmentWindow }).window!.electronAPI!.getAttachmentUrl!(
        attachmentId,
      )
    : getAttachmentProtocolUrl(attachmentId)
