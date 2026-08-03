import { imageAttachmentSchema, type ImageAttachment } from './schema.js'

export const imageAttachmentClipboardAttribute = 'data-chill-vibe-image-attachment'

const escapeHtmlAttribute = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('"', '&quot;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

const hasSafeAttachmentId = (attachment: ImageAttachment) =>
  /^[a-zA-Z0-9._-]+$/.test(attachment.id) &&
  !attachment.id.includes('..')

export const createImageAttachmentClipboardHtml = (
  attachment: ImageAttachment,
  imageSource: string,
) => {
  const parsed = imageAttachmentSchema.parse(attachment)
  if (!hasSafeAttachmentId(parsed)) {
    throw new Error('Invalid image attachment id.')
  }

  const metadata = encodeURIComponent(JSON.stringify(parsed))
  return `<img src="${escapeHtmlAttribute(imageSource)}" alt="${escapeHtmlAttribute(parsed.fileName)}" ${imageAttachmentClipboardAttribute}="${metadata}">`
}

export const parseImageAttachmentsFromClipboardHtml = (html: string): ImageAttachment[] => {
  if (!html || html.length > 2_000_000) return []

  const encodedValues: string[] = []
  const doubleQuoted = new RegExp(`${imageAttachmentClipboardAttribute}\\s*=\\s*"([^"]*)"`, 'giu')
  const singleQuoted = new RegExp(`${imageAttachmentClipboardAttribute}\\s*=\\s*'([^']*)'`, 'giu')

  for (const pattern of [doubleQuoted, singleQuoted]) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) encodedValues.push(match[1])
    }
  }

  const seen = new Set<string>()
  const attachments: ImageAttachment[] = []
  for (const encoded of encodedValues) {
    try {
      const parsed = imageAttachmentSchema.safeParse(JSON.parse(decodeURIComponent(encoded)))
      if (!parsed.success || !hasSafeAttachmentId(parsed.data) || seen.has(parsed.data.id)) continue
      seen.add(parsed.data.id)
      attachments.push(parsed.data)
    } catch {
      // Clipboard HTML is untrusted input. Ignore malformed metadata and keep
      // the existing external-image paste path available to the caller.
    }
  }

  return attachments
}
