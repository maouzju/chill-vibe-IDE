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
    const settled = { diskLoadPending: false }
    assert.equal(shouldPersistStickyNoteDocument({ ...settled, hasLocalDocument: false, content: '', attachments: [] }), false)
    assert.equal(shouldPersistStickyNoteDocument({ ...settled, hasLocalDocument: false, content: '正文', attachments: [] }), true)
    assert.equal(
      shouldPersistStickyNoteDocument({ ...settled, hasLocalDocument: false, content: '', attachments: [attachment('image-only')] }),
      true,
    )
    assert.equal(shouldPersistStickyNoteDocument({ ...settled, hasLocalDocument: true, content: '', attachments: [] }), true)
  })

  it('never saves while the on-disk note is still loading, so an early unmount cannot wipe its images', () => {
    // The mount effect resets attachments to [] until loadStickyNote resolves; the
    // server overwrites the index with whatever attachments a save carries.
    assert.equal(
      shouldPersistStickyNoteDocument({ diskLoadPending: true, hasLocalDocument: false, content: '正文', attachments: [] }),
      false,
    )
    assert.equal(
      shouldPersistStickyNoteDocument({ diskLoadPending: true, hasLocalDocument: true, content: '正文', attachments: [] }),
      false,
    )
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
