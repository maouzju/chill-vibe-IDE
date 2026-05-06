import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveQueuedSendTargetColumnId,
  summarizeQueuedSends,
} from '../src/components/deferred-send-queue.ts'

const columns = [
  {
    id: 'old-col',
    workspacePath: 'D:/old-workspace',
    cards: {},
  },
  {
    id: 'new-col',
    workspacePath: 'D:/new-workspace',
    cards: {
      'card-1': {},
    },
  },
]

test('queued send summaries show the next prompt and attachment count', () => {
  assert.deepEqual(
    summarizeQueuedSends([
      {
        id: 'request-1',
        prompt: '  Follow up\nwith   spacing  ',
        attachments: [{ id: 'image-1', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 128 }],
      },
    ]),
    {
      count: 1,
      nextPreview: 'Follow up with spacing',
      nextAttachmentCount: 1,
    },
  )
})

test('queued sends resolve the current card owner after a cross-column move', () => {
  assert.equal(resolveQueuedSendTargetColumnId(columns, 'old-col', 'card-1'), 'new-col')
})

test('queued sends are dropped when the card no longer belongs to a workspace column', () => {
  assert.equal(
    resolveQueuedSendTargetColumnId(
      [
        {
          id: 'empty-workspace-col',
          workspacePath: '   ',
          cards: {
            'card-1': {},
          },
        },
      ],
      'empty-workspace-col',
      'card-1',
    ),
    null,
  )
})
