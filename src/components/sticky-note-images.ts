import type { ImageAttachment } from '../../shared/schema'

export const shouldPersistStickyNoteDocument = (
  hasLocalDocument: boolean,
  content: string,
  attachments: readonly ImageAttachment[],
) => hasLocalDocument || content.trim().length > 0 || attachments.length > 0

export const mergeStickyNoteAttachments = (
  current: readonly ImageAttachment[],
  incoming: readonly ImageAttachment[],
  limit: number,
): ImageAttachment[] => {
  const seen = new Set(current.map((attachment) => attachment.id))
  const additions = incoming.filter((attachment) => {
    if (seen.has(attachment.id)) return false
    seen.add(attachment.id)
    return true
  })

  return [...current, ...additions].slice(0, Math.max(0, limit))
}
