import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexAppServerArgs } from '../server/providers.ts'

test('codex app-server launch args omit the optional --listen flag for legacy CLI compatibility', () => {
  const args = buildCodexAppServerArgs(['-c', 'model_provider="switch"'])

  assert.deepEqual(args, ['-c', 'model_provider="switch"', 'app-server'])
  assert.equal(args.includes('--listen'), false)
})
