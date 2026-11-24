import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_CODEX_MODEL } from '../shared/models'
import { createDefaultState } from '../shared/default-state'
import { ideReducer } from '../src/state'

describe('restoring a history entry with pending wake messages', () => {
  it('puts the unsent wake prompt back into the composer draft', () => {
    const state = createDefaultState()
    const entry = {
      id: 'h1',
      title: '待唤醒',
      provider: 'codex' as const,
      model: DEFAULT_CODEX_MODEL,
      workspacePath: state.columns[0].workspacePath,
      messages: [],
      pendingWake: { prompt: '等构建完再跑回归', attachments: [] },
      archivedAt: new Date().toISOString(),
    }
    const next = ideReducer({ ...state, sessionHistory: [entry] }, {
      type: 'restoreSession', columnId: state.columns[0].id, entryId: 'h1',
    } as never)
    const restored = Object.values(next.columns[0].cards).find((c) => c.title === '待唤醒')
    assert.equal(restored?.draft, '等构建完再跑回归')
  })
})
