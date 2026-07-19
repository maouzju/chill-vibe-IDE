import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNodeTestArgs,
  detectNodeTestForceExitSupport,
  parseRegisteredTestFiles,
  resolveDefaultConcurrency,
  resolveFocusedTestFiles,
} from '../scripts/run-node-tests.mjs'

test('node test runner parses the index manifest in registration order', () => {
  const source = `
import './alpha.test.ts'
import './nested-name.test.tsx'
import './legacy.test.js'
import './not-a-test.ts'
`

  assert.deepEqual(parseRegisteredTestFiles(source), [
    'tests/alpha.test.ts',
    'tests/nested-name.test.tsx',
    'tests/legacy.test.js',
  ])
})

test('node test runner only accepts focused files registered by the manifest', () => {
  const registered = ['tests/alpha.test.ts', 'tests/beta.test.ts']

  assert.deepEqual(resolveFocusedTestFiles(registered, ['alpha.test.ts']), ['tests/alpha.test.ts'])
  assert.deepEqual(resolveFocusedTestFiles(registered, ['tests/beta.test.ts']), [
    'tests/beta.test.ts',
  ])
  assert.deepEqual(resolveFocusedTestFiles(registered, ['alpha.test.ts beta.test.ts']), [
    'tests/alpha.test.ts',
    'tests/beta.test.ts',
  ])
  assert.throws(
    () => resolveFocusedTestFiles(registered, ['missing.test.ts']),
    /not registered/u,
  )
})

test('node test runner enables bounded file-level concurrency and supported force-exit cleanup', () => {
  assert.equal(resolveDefaultConcurrency('win32', 16), 2)
  assert.equal(resolveDefaultConcurrency('linux', 16), 4)
  assert.equal(resolveDefaultConcurrency('win32', 1), 1)
  assert.deepEqual(createNodeTestArgs(['tests/alpha.test.ts'], 3, true), [
    '--import',
    'tsx',
    '--test',
    '--test-force-exit',
    '--test-concurrency=3',
    'tests/alpha.test.ts',
  ])
  assert.equal(createNodeTestArgs(['tests/alpha.test.ts'], 3, false).includes('--test-force-exit'), false)
  assert.equal(
    detectNodeTestForceExitSupport('node', () => ({ status: 0, error: undefined })),
    true,
  )
  assert.equal(
    detectNodeTestForceExitSupport('node', () => ({ status: 9, error: undefined })),
    false,
  )
})
