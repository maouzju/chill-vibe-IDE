import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { resolveAutomationBoardTemplateInstanceSync } from '../src/components/automation-board-template-sync.ts'
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from '../shared/models.ts'
import type { AutomationBoardTemplate, ChatCard } from '../shared/schema.ts'

const template = (patch: Partial<AutomationBoardTemplate> = {}): AutomationBoardTemplate => ({
  id: 'tpl-1',
  name: '看板监工',
  requirement: '检查交付情况',
  provider: 'codex',
  model: DEFAULT_CODEX_MODEL,
  reasoningEffort: 'max',
  thinkingEnabled: true,
  planMode: false,
  adminAccess: true,
  builtIn: true,
  trigger: { enabled: true, kind: 'last-item-settled', lane: 'running', minIntervalMinutes: 1 },
  instanceCardId: 'card-1',
  wakeTimerActive: false,
  repeatLoopActive: false,
  ...patch,
})

const card = (patch: Partial<ChatCard> = {}) =>
  ({
    id: 'card-1',
    title: '监工',
    status: 'idle',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    adminAccess: true,
    messages: [],
    ...patch,
  }) as ChatCard

describe('automation board template instance sync', () => {
  it('asks for nothing when the instance already matches the template', () => {
    assert.equal(resolveAutomationBoardTemplateInstanceSync(template(), card()), null)
  })

  // 2026-08-16 用户现场：模板是 claude + 跟随默认，复用的监工卡却还在
  // codex/gpt-5.6-sol 上跑。改模板等于白改，用户读作"配置没保存"。
  it('moves the instance onto the model the template now names', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ provider: 'claude', model: '' }),
      card(),
    )

    // `model: ''` 是"用默认模型"，落到卡上必须是一个具体型号。
    assert.deepEqual(sync?.model, { provider: 'claude', model: DEFAULT_CLAUDE_MODEL })
  })

  it('treats an empty template model as already-matching when the card is on that default', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ provider: 'claude', model: '' }),
      card({ provider: 'claude', model: DEFAULT_CLAUDE_MODEL }),
    )

    assert.equal(sync, null)
  })

  it('carries the thinking, depth, plan and admin switches over', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ reasoningEffort: 'high', thinkingEnabled: false, adminAccess: false }),
      card(),
    )

    assert.equal(sync?.model, undefined)
    assert.deepEqual(sync?.patch, {
      reasoningEffort: 'high',
      thinkingEnabled: false,
      adminAccess: false,
    })
  })

  // 深度档位随 provider/model 变（Codex 老模型没有 max/ultra）。同步时必须走
  // 同一条归一化，否则会把一个启动即被 CLI 拒绝的档位钉到卡上。
  it('normalizes the depth against the model the instance is moving to', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ provider: 'claude', model: DEFAULT_CLAUDE_MODEL, reasoningEffort: 'ultra' }),
      card({ provider: 'claude', model: DEFAULT_CLAUDE_MODEL, reasoningEffort: 'high' }),
    )

    assert.notEqual(sync?.patch?.reasoningEffort, 'ultra')
  })

  // 2026-08-16 发布前审计抓到：`selectCardModel` 的最后一步会把卡上的档位
  // 覆盖成"该模型被记住的偏好档"（state.ts 的 getPreferredReasoningEffort）。
  // 于是"模板换了模型、深度看着没变"这种最常见的组合里，模板的深度会在换模型
  // 那一瞬间被静默改掉 —— 正是这个模块要根治的"改了不生效"，只是换了个字段。
  // 所以只要模型要动，档位就必须一起进 patch（App.tsx 里 patch 排在换模型之后）。
  it('always restates the depth when the model moves, because selecting a model resets it', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ provider: 'claude', model: DEFAULT_CLAUDE_MODEL, reasoningEffort: 'high' }),
      card({ provider: 'claude', model: 'claude-sonnet-4-5', reasoningEffort: 'high' }),
    )

    assert.equal(sync?.model?.model, DEFAULT_CLAUDE_MODEL)
    assert.equal(sync?.patch?.reasoningEffort, 'high')
  })

  it('only reports the fields that actually differ', () => {
    const sync = resolveAutomationBoardTemplateInstanceSync(
      template({ planMode: true }),
      card(),
    )

    assert.deepEqual(sync?.patch, { planMode: true })
  })

  // 纯函数测得再全，也管不到调用方怎么把结果用出去 —— 而这次的两个真 bug
  // （全局默认被后台改写、档位被换模型重置）都长在那段接线上，纯函数一条都照不到。
  // 触发器活在 App.tsx 的一个闭包里，没有可单测的出口，所以这里退而求其次钉源码
  // 形状：换模型那一步必须显式关掉"记住全局偏好"。
  // 反向验证过：把 `false` 去掉，这条当场红。
  it('fires the trigger-side model switch with global preference remembering turned off', async () => {
    const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
    const call = source.match(
      /changeCardModelSelectionRef\.current\?\.\(\s*columnId,\s*reuseCardId,[\s\S]{0,400}?\)/,
    )

    assert.ok(call, '找不到触发器里的换模型调用；接线改过就得同步改这条守卫')
    assert.match(
      call[0],
      /\bfalse\b/,
      '看板模板触发器换模型时必须传 rememberGlobalPreference=false，否则后台触发会改写用户的全局默认模型',
    )
  })
})
