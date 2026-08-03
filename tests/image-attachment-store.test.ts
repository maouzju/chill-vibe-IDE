import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { resolveImageAttachmentPath, storeImageAttachment } from '../server/attachments.ts'

describe('image attachment byte preservation', () => {
  let dataDir = ''
  let previousDataDir: string | undefined

  beforeEach(() => {
    previousDataDir = process.env.CHILL_VIBE_DATA_DIR
    dataDir = path.join(os.tmpdir(), `chill-vibe-image-bytes-${randomUUID()}`)
    process.env.CHILL_VIBE_DATA_DIR = dataDir
  })

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CHILL_VIBE_DATA_DIR
    else process.env.CHILL_VIBE_DATA_DIR = previousDataDir
    await rm(dataDir, { recursive: true, force: true })
  })

  it('writes and resolves the exact original bytes without image decoding or re-encoding', async () => {
    const original = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0xff, 0x10, 0x80])
    const attachment = await storeImageAttachment({
      fileName: 'animation.gif',
      mimeType: 'image/gif',
      dataBase64: original.toString('base64'),
    })

    assert.equal(attachment.fileName, 'animation.gif')
    assert.equal(attachment.mimeType, 'image/gif')
    assert.equal(attachment.sizeBytes, original.byteLength)
    assert.deepEqual(await readFile(await resolveImageAttachmentPath(attachment.id)), original)
  })
})
