import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createImageAttachmentClipboardHtml,
  parseImageAttachmentsFromClipboardHtml,
} from '../shared/image-attachment-clipboard.ts'

const screenshot = {
  id: 'sticky-screenshot.png',
  fileName: '需求截图 "最终版".png',
  mimeType: 'image/png' as const,
  sizeBytes: 4_096,
}

describe('image attachment clipboard metadata', () => {
  it('round-trips the original attachment metadata through standard HTML clipboard content', () => {
    const html = createImageAttachmentClipboardHtml(
      screenshot,
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    )

    assert.match(html, /data-chill-vibe-image-attachment=/)
    assert.deepEqual(parseImageAttachmentsFromClipboardHtml(html), [screenshot])
  })

  it('escapes image sources and filenames before writing standard HTML', () => {
    const unsafeAttachment = {
      ...screenshot,
      fileName: 'bad"><script>alert(1)</script>.png',
    }
    const html = createImageAttachmentClipboardHtml(
      unsafeAttachment,
      'data:image/png;base64,AA==" onerror="alert(1)',
    )

    assert.doesNotMatch(html, /<script>| onerror="alert/)
    assert.deepEqual(parseImageAttachmentsFromClipboardHtml(html), [unsafeAttachment])
  })

  it('ignores malformed or schema-invalid metadata instead of creating unsafe attachments', () => {
    assert.deepEqual(
      parseImageAttachmentsFromClipboardHtml(
        '<img data-chill-vibe-image-attachment="%7Bbroken" src="file:///secret.png">',
      ),
      [],
    )
    assert.deepEqual(
      parseImageAttachmentsFromClipboardHtml(
        `<img data-chill-vibe-image-attachment="${encodeURIComponent(JSON.stringify({
          ...screenshot,
          id: '../secret.png',
          sizeBytes: 0,
        }))}">`,
      ),
      [],
    )
  })

  it('deduplicates repeated HTML image nodes by attachment id while preserving order', () => {
    const first = createImageAttachmentClipboardHtml(screenshot, 'chill-vibe-attachment://local/sticky-screenshot.png')
    const duplicate = createImageAttachmentClipboardHtml(
      { ...screenshot, fileName: '重复名字.png' },
      'chill-vibe-attachment://local/sticky-screenshot.png',
    )
    const secondAttachment = {
      id: 'sticky-reference.webp',
      fileName: '参考图.webp',
      mimeType: 'image/webp' as const,
      sizeBytes: 2_048,
    }
    const second = createImageAttachmentClipboardHtml(
      secondAttachment,
      'chill-vibe-attachment://local/sticky-reference.webp',
    )

    assert.deepEqual(
      parseImageAttachmentsFromClipboardHtml(`${first}${duplicate}${second}`),
      [screenshot, secondAttachment],
    )
  })
})
