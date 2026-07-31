import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolDetails } from '../src/components/structured-tool-details.ts'

const WORKSPACE = 'D:/Git/chill-vibe'

test('Read tool details expose the CLI-reported file path as an editor target', () => {
  const details = buildToolDetails('zh-CN', 'Read', { file_path: 'D:\\Git\\chill-vibe\\src\\state.ts' }, WORKSPACE)
  const fileDetail = details.find((detail) => detail.openPath)

  assert.ok(fileDetail, `expected an openable detail in ${JSON.stringify(details)}`)
  assert.equal(fileDetail.openPath, 'src/state.ts')
  assert.equal(fileDetail.openLine, undefined)
})

test('a Read with an offset opens the editor at the line the agent actually read', () => {
  const details = buildToolDetails(
    'zh-CN',
    'Read',
    { file_path: 'src/state.ts', offset: '1800', limit: '120' },
    WORKSPACE,
  )
  const fileDetail = details.find((detail) => detail.openPath)

  assert.ok(fileDetail)
  assert.equal(fileDetail.openPath, 'src/state.ts')
  assert.equal(fileDetail.openLine, 1800)
})

test('Edit and Write tools also surface their target file', () => {
  for (const toolName of ['Edit', 'Write']) {
    const details = buildToolDetails('zh-CN', toolName, { file_path: 'src/App.tsx' }, WORKSPACE)
    const fileDetail = details.find((detail) => detail.openPath)

    assert.ok(fileDetail, `${toolName} should expose its file`)
    assert.equal(fileDetail.openPath, 'src/App.tsx')
  }
})

test('non-file tool details never become editor targets', () => {
  const bash = buildToolDetails('zh-CN', 'Bash', { command: 'pnpm test', description: 'run tests' }, WORKSPACE)
  assert.deepEqual(bash.filter((detail) => detail.openPath), [])

  const grep = buildToolDetails('zh-CN', 'Grep', { pattern: 'src/state.ts', glob: '*.ts' }, WORKSPACE)
  assert.deepEqual(grep.filter((detail) => detail.openPath), [])

  const web = buildToolDetails('zh-CN', 'WebFetch', { url: 'https://example.com/a.ts' }, WORKSPACE)
  assert.deepEqual(web.filter((detail) => detail.openPath), [])
})

test('without a workspace the file detail stays plain text', () => {
  const details = buildToolDetails('zh-CN', 'Read', { file_path: 'src/state.ts' }, '')

  assert.equal(details.length > 0, true)
  assert.deepEqual(details.filter((detail) => detail.openPath), [])
})
