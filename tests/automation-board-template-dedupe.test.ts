import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  automationBoardSupervisorTemplateId,
  createDefaultSettings,
} from '../shared/default-state.ts'
import { DEFAULT_CODEX_MODEL } from '../shared/models.ts'

const timestamp = '2026-08-12T00:00:00.000Z'

/**
 * 症状：看板模板栏里出现两条同名「看板监工」，删掉其中一条另一条也一起消失。
 * 根因：内置监工的 id 是硬编码常量，而 v1→v2 迁移只用 `builtIn === true` 判断
 * "已经有内置模板了没有"。旧存档里那条监工模板压根没写过 `builtIn` 字段
 * （schema 的 default(false) 在 parse 时才补，迁移跑在 parse **之前**），
 * 于是迁移又 unshift 了一条同 id 的默认监工 —— 两条 id 完全一样。
 * 删除按 id filter，自然一次删两条。
 */
describe('automation board template dedupe', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `chill-vibe-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  const writePersisted = async (workspace: unknown) => {
    const persisted = {
      settings: createDefaultSettings(),
      version: 1,
      updatedAt: timestamp,
      sessionHistory: [],
      stickyNoteArchive: {},
      automationBoards: { 'D:/legacy-board': workspace },
      columns: [
        {
          id: 'column-1',
          title: 'Workspace',
          provider: 'codex',
          workspacePath: 'D:/legacy-board',
          model: DEFAULT_CODEX_MODEL,
          layout: { type: 'pane', id: 'pane-1', tabs: ['card-1'], activeTabId: 'card-1' },
          cards: {
            'card-1': {
              id: 'card-1',
              title: 'Chat',
              status: 'idle',
              provider: 'codex',
              model: DEFAULT_CODEX_MODEL,
              messages: [],
            },
          },
        },
      ],
    }

    await writeFile(path.join(tmpDir, 'state.json'), JSON.stringify(persisted), 'utf8')
  }

  const legacySupervisorTemplate = {
    // 旧存档写下的监工模板：用户已经把它改成了 codex，且**没有** builtIn 字段。
    id: automationBoardSupervisorTemplateId,
    name: '看板监工',
    requirement: '检查当前看板每个原始需求',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    thinkingEnabled: true,
    planMode: false,
    adminAccess: true,
    trigger: { enabled: true, kind: 'last-item-settled', lane: 'running', minIntervalMinutes: 5 },
    instanceCardId: '',
    wakeTimerActive: false,
    repeatLoopActive: false,
  }

  it('never seeds a second supervisor next to a legacy one that lacks builtIn', async () => {
    const { loadState } = await import('../server/state-store.ts')
    await writePersisted({
      autoTrigger: { enabled: true, minIntervalMinutes: 5 },
      templates: [legacySupervisorTemplate],
    })

    const loaded = await loadState()
    // 先证明加载的确实是这份夹具（loadState 在夹具不合法时会静默回落到默认状态）。
    assert.equal(loaded.columns[0]?.workspacePath, 'D:/legacy-board')

    const templates = loaded.automationBoards['D:/legacy-board']?.templates ?? []
    const supervisors = templates.filter(
      (template) => template.id === automationBoardSupervisorTemplateId,
    )

    assert.equal(supervisors.length, 1)
    // 留下的必须是用户那份配置，不是被默认模板洗回 claude。
    assert.equal(supervisors[0]?.provider, 'codex')
    assert.equal(supervisors[0]?.model, 'gpt-5.6-sol')
  })

  it('collapses duplicate template ids that a previous version already persisted', async () => {
    const { loadState } = await import('../server/state-store.ts')
    await writePersisted({
      // 上一版把重复固化进了存档：加载时必须收敛掉，否则删一条会删两条。
      templates: [
        { ...legacySupervisorTemplate, provider: 'claude', model: '', builtIn: true },
        legacySupervisorTemplate,
      ],
    })

    const loaded = await loadState()
    assert.equal(loaded.columns[0]?.workspacePath, 'D:/legacy-board')

    const templates = loaded.automationBoards['D:/legacy-board']?.templates ?? []
    assert.equal(templates.length, 1)
    assert.equal(templates[0]?.id, automationBoardSupervisorTemplateId)
  })
})
