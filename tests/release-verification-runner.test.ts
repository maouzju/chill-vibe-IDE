import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createStageInvocation,
  createVerificationFingerprint,
  resetInvalidatedVerificationState,
  resolveReleaseStagePlan,
} from '../scripts/run-release-verification.mjs'

const stages = [
  { id: 'quality', command: 'pnpm', args: ['test:quality'] },
  { id: 'node', command: 'pnpm', args: ['test'] },
]

test('release verification fingerprint changes with tracked or untracked content', () => {
  const base = {
    repoRoot: 'D:/Git/chill-vibe',
    head: 'abc123',
    trackedDiff: 'diff --git a/a.ts b/a.ts',
    untrackedEntries: [{ path: 'notes.txt', hash: 'hash-a', mode: 'file' }],
  }

  const original = createVerificationFingerprint(base)

  assert.equal(createVerificationFingerprint({ ...base }), original)
  assert.notEqual(
    createVerificationFingerprint({ ...base, trackedDiff: `${base.trackedDiff}\n+change` }),
    original,
  )
  assert.notEqual(
    createVerificationFingerprint({
      ...base,
      untrackedEntries: [{ path: 'notes.txt', hash: 'hash-b', mode: 'file' }],
    }),
    original,
  )
})

test('release stage plan only reuses matching passed evidence', () => {
  const state = {
    fingerprint: 'tree-a',
    stages: {
      quality: { status: 'passed', command: 'pnpm test:quality' },
      node: { status: 'failed', command: 'pnpm test' },
    },
  }

  assert.deepEqual(
    resolveReleaseStagePlan({
      stages,
      state,
      fingerprint: 'tree-a',
      fresh: false,
      selectedStageIds: [],
    }).map(({ id, action }) => ({ id, action })),
    [
      { id: 'quality', action: 'reuse' },
      { id: 'node', action: 'run' },
    ],
  )

  assert.deepEqual(
    resolveReleaseStagePlan({
      stages,
      state,
      fingerprint: 'tree-b',
      fresh: false,
      selectedStageIds: [],
    }).map(({ id, action }) => ({ id, action })),
    [
      { id: 'quality', action: 'run' },
      { id: 'node', action: 'run' },
    ],
  )
})

test('release stage plan supports fresh and focused reruns without claiming missing gates are green', () => {
  const state = {
    fingerprint: 'tree-a',
    stages: {
      quality: { status: 'passed', command: 'pnpm test:quality' },
      node: { status: 'passed', command: 'pnpm test' },
    },
  }

  const freshPlan = resolveReleaseStagePlan({
    stages,
    state,
    fingerprint: 'tree-a',
    fresh: true,
    selectedStageIds: [],
  })
  assert.deepEqual(freshPlan.map(({ action }) => action), ['run', 'run'])

  const focusedPlan = resolveReleaseStagePlan({
    stages,
    state: { fingerprint: 'tree-a', stages: {} },
    fingerprint: 'tree-a',
    fresh: false,
    selectedStageIds: ['node'],
  })
  assert.deepEqual(
    focusedPlan.map(({ id, action }) => ({ id, action })),
    [
      { id: 'quality', action: 'not-selected' },
      { id: 'node', action: 'run' },
    ],
  )
})

test('release stages use cmd directly on Windows instead of Node shell concatenation', () => {
  const stage = stages[0]

  assert.deepEqual(createStageInvocation(stage, 'win32', 'C:/Windows/System32/cmd.exe'), {
    command: 'C:/Windows/System32/cmd.exe',
    args: ['/d', '/s', '/c', 'pnpm test:quality'],
  })
  assert.deepEqual(createStageInvocation(stage, 'linux'), {
    command: 'pnpm',
    args: ['test:quality'],
  })
})

test('invalidated mixed-tree evidence is discarded before any focused rerun', () => {
  assert.deepEqual(
    resetInvalidatedVerificationState({
      fingerprint: 'tree-a',
      invalidatedAt: '2026-07-18T00:00:00.000Z',
      invalidatedByFingerprint: 'tree-b',
      stages: {
        quality: { status: 'passed', command: 'pnpm test:quality' },
      },
    }),
    {
      fingerprint: 'tree-a',
      stages: {},
    },
  )
})
