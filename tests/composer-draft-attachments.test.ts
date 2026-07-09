import assert from 'node:assert/strict'
import test from 'node:test'

import { getImageAttachmentUrl } from '../shared/chat-attachments.ts'
import type { ImageAttachment } from '../shared/schema.ts'
import {
  collectPersistedDraftAttachments,
  hydrateDraftAttachments,
  promoteDraftAttachment,
  sameImageAttachmentLists,
  type PendingComposerAttachment,
} from '../src/components/composer-draft-attachments'

const uploadedAttachment = (id: string): ImageAttachment => ({
  id,
  fileName: `${id}.png`,
  mimeType: 'image/png',
  sizeBytes: 1024,
})

const localEntry = (id: string): PendingComposerAttachment => ({
  kind: 'local',
  id,
  file: new File(['x'], `${id}.png`, { type: 'image/png' }),
  previewUrl: `blob:${id}`,
})

const uploadedEntry = (id: string): PendingComposerAttachment => ({
  kind: 'uploaded',
  id,
  attachment: uploadedAttachment(id),
  previewUrl: `attachment://${id}`,
})

test('collectPersistedDraftAttachments keeps only uploaded attachments in order', () => {
  const pending = [localEntry('a'), uploadedEntry('b'), localEntry('c'), uploadedEntry('d')]

  assert.deepEqual(
    collectPersistedDraftAttachments(pending).map((attachment) => attachment.id),
    ['b', 'd'],
  )
})

test('collectPersistedDraftAttachments returns empty for local-only pending lists', () => {
  assert.deepEqual(collectPersistedDraftAttachments([localEntry('a')]), [])
  assert.deepEqual(collectPersistedDraftAttachments([]), [])
})

test('sameImageAttachmentLists compares by id sequence', () => {
  const a = uploadedAttachment('a')
  const b = uploadedAttachment('b')

  assert.equal(sameImageAttachmentLists([a, b], [uploadedAttachment('a'), uploadedAttachment('b')]), true)
  assert.equal(sameImageAttachmentLists([], []), true)
  assert.equal(sameImageAttachmentLists([a], [a, b]), false)
  assert.equal(sameImageAttachmentLists([a, b], [b, a]), false)
  assert.equal(sameImageAttachmentLists([a], [b]), false)
})

test('promoteDraftAttachment upgrades the local entry in place and reports the replaced entry', () => {
  const local = localEntry('mid')
  const pending = [uploadedEntry('first'), local, localEntry('last')]
  const uploaded = uploadedAttachment('mid-uploaded')

  const result = promoteDraftAttachment(pending, 'mid', uploaded, 'attachment://mid-uploaded')

  assert.equal(result.replaced, local)
  assert.equal(result.next.length, 3)
  assert.equal(result.next[0], pending[0])
  assert.equal(result.next[2], pending[2])
  const promoted = result.next[1]
  assert.equal(promoted.kind, 'uploaded')
  if (promoted.kind === 'uploaded') {
    assert.equal(promoted.attachment, uploaded)
    assert.equal(promoted.previewUrl, 'attachment://mid-uploaded')
    // Keeps the original pending id so removal by id still works mid-upload.
    assert.equal(promoted.id, 'mid')
  }
})

test('promoteDraftAttachment is a no-op when the entry was removed before the upload finished', () => {
  const pending = [uploadedEntry('keep')]

  const result = promoteDraftAttachment(pending, 'gone', uploadedAttachment('gone'), 'attachment://gone')

  assert.equal(result.next, pending)
  assert.equal(result.replaced, null)
})

test('promoteDraftAttachment is a no-op when the entry is already uploaded', () => {
  const pending = [uploadedEntry('done')]

  const result = promoteDraftAttachment(pending, 'done', uploadedAttachment('done'), 'attachment://done')

  assert.equal(result.next, pending)
  assert.equal(result.replaced, null)
})

test('hydrateDraftAttachments rebuilds uploaded pending entries from persisted draft attachments', () => {
  const persisted = [uploadedAttachment('a'), uploadedAttachment('b')]

  const hydrated = hydrateDraftAttachments(persisted)

  assert.equal(hydrated.length, 2)
  for (const [index, entry] of hydrated.entries()) {
    assert.equal(entry.kind, 'uploaded')
    if (entry.kind === 'uploaded') {
      assert.equal(entry.attachment, persisted[index])
      assert.equal(entry.id, persisted[index].id)
      assert.equal(entry.previewUrl, getImageAttachmentUrl(persisted[index].id))
    }
  }
})
