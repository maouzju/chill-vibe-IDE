import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImageAttachment } from '../shared/schema.ts'
import {
  mergeStickyNoteAttachments,
  shouldPersistStickyNoteDocument,
} from '../src/components/sticky-note-images.ts'

const attachment = (id: string): ImageAttachment => ({
  id: `${id}.png`,
  fileName: `${id}.png`,
  mimeType: 'image/png',
  sizeBytes: 128,
})

describe('sticky note image state helpers', () => {
  it('persists a new image-only note while keeping a truly empty new note virtual', () => {
    assert.equal(shouldPersistStickyNoteDocument(false, '', []), false)
    assert.equal(shouldPersistStickyNoteDocument(false, '正文', []), true)
    assert.equal(shouldPersistStickyNoteDocument(false, '', [attachment('image-only')]), true)
    assert.equal(shouldPersistStickyNoteDocument(true, '', []), true)
  })

  it('keeps insertion order, deduplicates ids, and respects the attachment limit', () => {
    assert.deepEqual(
      mergeStickyNoteAttachments(
        [attachment('first')],
        [attachment('first'), attachment('second'), attachment('third')],
        2,
      ).map((entry) => entry.id),
      ['first.png', 'second.png'],
    )
  })
})
