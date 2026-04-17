import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildSpecChatPrompt,
  buildSpecFileSet,
  buildSpecSeedDocuments,
  normalizeSpecSlug,
} from '../shared/spec-first.ts'

describe('SPEC-first helpers', () => {
  it('builds stable docs/specs paths from feature titles', () => {
    assert.equal(normalizeSpecSlug('  OAuth Login Flow  '), 'oauth-login-flow')
    assert.equal(normalizeSpecSlug('需求 先行'), '需求-先行')
    assert.equal(normalizeSpecSlug('***'), 'untitled-spec')

    assert.deepEqual(buildSpecFileSet('OAuth Login Flow'), {
      title: 'OAuth Login Flow',
      slug: 'oauth-login-flow',
      folderRelativePath: 'docs/specs/oauth-login-flow',
      requirementsPath: 'docs/specs/oauth-login-flow/requirements.md',
      designPath: 'docs/specs/oauth-login-flow/design.md',
      tasksPath: 'docs/specs/oauth-login-flow/tasks.md',
    })
  })

  it('seeds requirements, design, and tasks without production-code instructions', () => {
    const docs = buildSpecSeedDocuments('OAuth Login Flow', 'en')

    assert.match(docs.requirements, /# Requirements: OAuth Login Flow/)
    assert.match(docs.design, /# Design: OAuth Login Flow/)
    assert.match(docs.tasks, /# Tasks: OAuth Login Flow/)
    assert.match(docs.tasks, /Do not start production code/)
  })

  it('creates an agent handoff prompt that requires docs before code', () => {
    const prompt = buildSpecChatPrompt(buildSpecFileSet('OAuth Login Flow'), 'en')

    assert.match(prompt, /SPEC-first/)
    assert.match(prompt, /requirements\.md/)
    assert.match(prompt, /design\.md/)
    assert.match(prompt, /tasks\.md/)
    assert.match(prompt, /Do not edit production code before/)
  })
})
