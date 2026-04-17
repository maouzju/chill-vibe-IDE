import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ensureSpecDocuments } from '../server/spec-first.ts'

test('ensureSpecDocuments creates the SPEC docs folder and starter markdown files', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-spec-first-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const result = await ensureSpecDocuments({
    workspacePath: workspace,
    title: 'OAuth Login Flow',
    language: 'en',
  })

  assert.equal(result.slug, 'oauth-login-flow')
  assert.equal(result.requirementsPath, 'docs/specs/oauth-login-flow/requirements.md')
  assert.equal(result.designPath, 'docs/specs/oauth-login-flow/design.md')
  assert.equal(result.tasksPath, 'docs/specs/oauth-login-flow/tasks.md')
  assert.equal(result.created.length, 3)

  const requirements = await readFile(path.join(workspace, result.requirementsPath), 'utf8')
  const design = await readFile(path.join(workspace, result.designPath), 'utf8')
  const tasks = await readFile(path.join(workspace, result.tasksPath), 'utf8')

  assert.match(requirements, /# Requirements: OAuth Login Flow/)
  assert.match(design, /# Design: OAuth Login Flow/)
  assert.match(tasks, /SPEC-first rule/)
})

test('ensureSpecDocuments keeps existing SPEC docs intact', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-spec-first-existing-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const first = await ensureSpecDocuments({
    workspacePath: workspace,
    title: 'OAuth Login Flow',
    language: 'en',
  })
  const requirementPath = path.join(workspace, first.requirementsPath)
  await mkdir(path.dirname(requirementPath), { recursive: true })
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(requirementPath, '# Custom requirements\n', 'utf8'),
  )

  const second = await ensureSpecDocuments({
    workspacePath: workspace,
    title: 'OAuth Login Flow',
    language: 'en',
  })

  assert.deepEqual(second.existing.sort(), [
    first.designPath,
    first.requirementsPath,
    first.tasksPath,
  ].sort())
  assert.equal(await readFile(requirementPath, 'utf8'), '# Custom requirements\n')
})
