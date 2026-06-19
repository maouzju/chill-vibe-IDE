import assert from 'node:assert/strict'
import test from 'node:test'

import { getImageFileMimeType, isImageFilePath } from '../src/components/image-file-routing'

test('image file routing detects supported image extensions case-insensitively', () => {
  assert.equal(isImageFilePath('assets/logo.PNG'), true)
  assert.equal(isImageFilePath('photos/cat.jpeg'), true)
  assert.equal(isImageFilePath('preview.webp'), true)
  assert.equal(isImageFilePath('icons/vector.SVG'), true)
  assert.equal(isImageFilePath('notes/readme.md'), false)
})

test('image file routing maps extensions to browser mime types', () => {
  assert.equal(getImageFileMimeType('assets/logo.png'), 'image/png')
  assert.equal(getImageFileMimeType('photos/cat.jpg'), 'image/jpeg')
  assert.equal(getImageFileMimeType('photos/cat.jpeg'), 'image/jpeg')
  assert.equal(getImageFileMimeType('preview.webp'), 'image/webp')
  assert.equal(getImageFileMimeType('icons/vector.svg'), 'image/svg+xml')
  assert.equal(getImageFileMimeType('notes/readme.md'), null)
})
