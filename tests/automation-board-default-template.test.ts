import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  automationBoardSupervisorTemplateId,
  createDefaultAutomationBoardSupervisorTemplate,
  createDefaultAutomationBoardWorkspaceState,
} from '../shared/default-state.ts'

describe('default automation board supervisor template', () => {
  // 看板本身是 codex 侧的工具卡，默认监工却是 claude —— 用户新建工作区拿到的
  // 是一份跟他实际在用的 CLI 不一致的模板。
  it('defaults to codex', () => {
    const template = createDefaultAutomationBoardSupervisorTemplate()

    assert.equal(template.provider, 'codex')
    assert.equal(template.id, automationBoardSupervisorTemplateId)
  })

  it('seeds exactly one template into a fresh workspace', () => {
    const workspace = createDefaultAutomationBoardWorkspaceState()

    assert.equal(workspace.templates.length, 1)
    assert.equal(workspace.templates[0]?.id, automationBoardSupervisorTemplateId)
  })

  // 2026-10-29 用户反馈：看板一打开，默认监工就是 Codex「超高」/ Claude「最高」，
  // 不跟设置里记住的默认档位走。空串 = 跟随设置，别在模板里钉死某一档。
  it('leaves the reasoning effort empty so it follows the configured default', () => {
    assert.equal(createDefaultAutomationBoardSupervisorTemplate().reasoningEffort, '')
  })
})
