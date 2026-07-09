// Pasted images live in component state as `local` File entries, which cannot
// survive a ChatCard unmount (pane tab switch, window teardown). The composer
// uploads them in the background and mirrors the uploaded set into
// `card.draftAttachments`, so the existing hydrate path can restore them.

import { getImageAttachmentUrl } from '../../shared/chat-attachments'
import type { ImageAttachment } from '../../shared/schema'

export type PendingComposerAttachment =
  | {
      kind: 'local'
      id: string
      file: File
      previewUrl: string
    }
  | {
      kind: 'uploaded'
      id: string
      attachment: ImageAttachment
      previewUrl: string
    }

export const collectPersistedDraftAttachments = (
  pending: readonly PendingComposerAttachment[],
): ImageAttachment[] =>
  pending.flatMap((entry) => (entry.kind === 'uploaded' ? [entry.attachment] : []))

export const sameImageAttachmentLists = (
  a: readonly ImageAttachment[],
  b: readonly ImageAttachment[],
): boolean => a.length === b.length && a.every((attachment, index) => attachment.id === b[index].id)

export const promoteDraftAttachment = (
  pending: readonly PendingComposerAttachment[],
  localId: string,
  uploaded: ImageAttachment,
  previewUrl: string,
): { next: readonly PendingComposerAttachment[]; replaced: PendingComposerAttachment | null } => {
  const index = pending.findIndex((entry) => entry.id === localId && entry.kind === 'local')

  if (index < 0) {
    return { next: pending, replaced: null }
  }

  const next = pending.slice()
  next[index] = {
    kind: 'uploaded',
    // The pending id stays stable across the upgrade so removal by id works mid-upload.
    id: localId,
    attachment: uploaded,
    previewUrl,
  }

  return { next, replaced: pending[index] }
}

export const hydrateDraftAttachments = (
  attachments: readonly ImageAttachment[],
): PendingComposerAttachment[] =>
  attachments.map((attachment) => ({
    kind: 'uploaded',
    id: attachment.id,
    attachment,
    previewUrl: getImageAttachmentUrl(attachment.id),
  }))
