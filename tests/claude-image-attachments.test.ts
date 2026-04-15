import assert from 'node:assert/strict'
import test from 'node:test'
import { providerSupportsImageAttachments } from '../shared/chat-attachments.ts'

test('providerSupportsImageAttachments returns true for claude', () => {
  assert.equal(providerSupportsImageAttachments('claude'), true)
})

test('providerSupportsImageAttachments returns true for codex', () => {
  assert.equal(providerSupportsImageAttachments('codex'), true)
})
