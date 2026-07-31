import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseFileReferenceCandidate,
  resolveMessageFileTarget,
  resolveMessageLinkFileTarget,
} from '../src/components/message-file-reference.ts'

const WORKSPACE = 'D:/Git/chill-vibe'

test('accepts inline code that looks like a workspace source file', () => {
  assert.deepEqual(parseFileReferenceCandidate('src/state.ts'), {
    path: 'src/state.ts',
    line: undefined,
  })
  assert.deepEqual(parseFileReferenceCandidate('dist/catalogSnapshot.js'), {
    path: 'dist/catalogSnapshot.js',
    line: undefined,
  })
  assert.deepEqual(parseFileReferenceCandidate('clean-stale-dist.mjs'), {
    path: 'clean-stale-dist.mjs',
    line: undefined,
  })
  assert.deepEqual(parseFileReferenceCandidate('scripts\\run-node-tests.mjs'), {
    path: 'scripts\\run-node-tests.mjs',
    line: undefined,
  })
})

test('rejects inline code that is an identifier, flag, or number rather than a path', () => {
  for (const candidate of [
    'regenerateSnapshotFiles',
    'writeFileSync',
    '--frozen-lockfile',
    '2%',
    'v1.5',
    'Catalog',
    '118ms',
    'a.b',
    '',
    '   ',
    'src/state.ts extra',
    'https://example.com/app.ts',
    'node:test',
  ]) {
    assert.equal(parseFileReferenceCandidate(candidate), null, `expected reject: ${candidate}`)
  }
})

test('parses trailing line anchors in every shape agents emit', () => {
  assert.deepEqual(parseFileReferenceCandidate('src/state.ts:120'), {
    path: 'src/state.ts',
    line: 120,
  })
  assert.deepEqual(parseFileReferenceCandidate('src/state.ts:120:8'), {
    path: 'src/state.ts',
    line: 120,
  })
  assert.deepEqual(parseFileReferenceCandidate('src/state.ts#L120'), {
    path: 'src/state.ts',
    line: 120,
  })
  assert.deepEqual(parseFileReferenceCandidate('src/state.ts#L120C8'), {
    path: 'src/state.ts',
    line: 120,
  })
})

test('never mistakes a Windows drive colon for a line anchor', () => {
  assert.deepEqual(parseFileReferenceCandidate('D:/Git/chill-vibe/src/state.ts'), {
    path: 'D:/Git/chill-vibe/src/state.ts',
    line: undefined,
  })
  assert.deepEqual(parseFileReferenceCandidate('D:\\Git\\chill-vibe\\src\\state.ts:42'), {
    path: 'D:\\Git\\chill-vibe\\src\\state.ts',
    line: 42,
  })
})

test('resolves inline references against the workspace', () => {
  assert.deepEqual(resolveMessageFileTarget(WORKSPACE, 'src/state.ts:120'), {
    openPath: 'src/state.ts',
    line: 120,
  })
  assert.deepEqual(resolveMessageFileTarget(WORKSPACE, 'D:\\Git\\chill-vibe\\src\\state.ts'), {
    openPath: 'src/state.ts',
    line: undefined,
  })
  assert.equal(resolveMessageFileTarget('', 'src/state.ts'), null)
  assert.equal(resolveMessageFileTarget(WORKSPACE, 'writeFileSync'), null)
})

test('keeps out-of-workspace absolute files openable, server whitelist stays the gate', () => {
  const target = resolveMessageFileTarget(WORKSPACE, 'C:/Users/yuze/.claude/settings.json')
  assert.deepEqual(target, {
    openPath: 'C:/Users/yuze/.claude/settings.json',
    line: undefined,
  })
})

test('explicit markdown links skip the extension whitelist but still reject directories', () => {
  assert.deepEqual(resolveMessageLinkFileTarget(WORKSPACE, 'docs/specs/README'), null)
  assert.deepEqual(resolveMessageLinkFileTarget(WORKSPACE, 'docs/specs/'), null)
  assert.deepEqual(resolveMessageLinkFileTarget(WORKSPACE, 'scripts/dev.fish'), {
    openPath: 'scripts/dev.fish',
    line: undefined,
  })
  assert.deepEqual(
    resolveMessageLinkFileTarget(WORKSPACE, 'file:///D:/Git/chill-vibe/src/state.ts#L12'),
    { openPath: 'src/state.ts', line: 12 },
  )
  assert.equal(resolveMessageLinkFileTarget(WORKSPACE, 'https://example.com/a.ts'), null)
})

test('markdown links may contain spaces because the author was explicit', () => {
  assert.deepEqual(resolveMessageLinkFileTarget(WORKSPACE, 'docs/my notes.md'), {
    openPath: 'docs/my notes.md',
    line: undefined,
  })
  assert.equal(parseFileReferenceCandidate('docs/my notes.md'), null)
})
