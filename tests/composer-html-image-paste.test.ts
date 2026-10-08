import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  collectPastedImageSources,
  fetchPastedImageFiles,
} from '../src/components/composer-image-paste.ts'

describe('HTML image paste', () => {
  it('extracts safe image sources and deduplicates them', () => {
    assert.deepEqual(
      collectPastedImageSources('<img src="data:image/png;base64,AA=="><img src="https://x.test/a.png"><img src="https://x.test/a.png"><img src="javascript:alert(1)">'),
      ['data:image/png;base64,AA==', 'https://x.test/a.png'],
    )
  })

  it('accepts Feishu lazy-loaded image attributes while ignoring unsafe sources', () => {
    assert.deepEqual(
      collectPastedImageSources(
        '<img src="/lazy.png" data-src="https://x.test/lazy.png"><img data-original="data:image/webp;base64,AA==">',
      ),
      ['https://x.test/lazy.png', 'data:image/webp;base64,AA=='],
    )
  })
  it('converts data URLs into image files', async () => {
    const files = await fetchPastedImageFiles(['data:image/png;base64,AA=='])
    assert.equal(files.length, 1)
    assert.equal(files[0].type, 'image/png')
    assert.equal(files[0].name, 'pasted-image-1.png')
  })

  it('skips inaccessible external images without throwing', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('cors') }
    try {
      assert.deepEqual(await fetchPastedImageFiles(['https://private.test/image.png']), [])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
