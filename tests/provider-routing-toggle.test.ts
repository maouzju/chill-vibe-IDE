import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { archiveCardToHistory, createCard } from '../shared/default-state'
import { DEFAULT_CODEX_MODEL, resolveReportedModelLabel } from '../shared/models'
import { defaultAppLanguage } from '../shared/i18n'
import { setProviderRouting } from '../shared/schema'

describe('setProviderRouting', () => {
  it('enabling one provider while the master switch is off keeps the others off', () => {
    const patch = setProviderRouting(
      { cliRoutingEnabled: false, cliRoutingDisabledProviders: [] },
      'gemini',
      true,
    )
    assert.deepEqual(patch, {
      cliRoutingEnabled: true,
      cliRoutingDisabledProviders: ['claude', 'codex'],
    })
  })

  it('enabling one provider while routing is on only removes it from the disabled list', () => {
    const patch = setProviderRouting(
      { cliRoutingEnabled: true, cliRoutingDisabledProviders: ['codex'] },
      'codex',
      true,
    )
    assert.deepEqual(patch, { cliRoutingEnabled: true, cliRoutingDisabledProviders: [] })
  })

  it('disabling a provider keeps the master state and never duplicates it', () => {
    const patch = setProviderRouting(
      { cliRoutingEnabled: true, cliRoutingDisabledProviders: ['codex'] },
      'codex',
      false,
    )
    assert.deepEqual(patch, { cliRoutingEnabled: true, cliRoutingDisabledProviders: ['codex'] })
  })

  it('disabling one provider while the master is off leaves the master off', () => {
    const patch = setProviderRouting(
      { cliRoutingEnabled: false, cliRoutingDisabledProviders: [] },
      'claude',
      false,
    )
    assert.deepEqual(patch, { cliRoutingEnabled: false, cliRoutingDisabledProviders: ['claude'] })
  })
})

describe('resolveReportedModelLabel', () => {
  it('expands bare aliases and concrete ids to the newest bound model', () => {
    assert.equal(resolveReportedModelLabel('fable'), 'Fable 5.2')
    assert.equal(resolveReportedModelLabel('claude-fable-5-2'), 'Fable 5.2')
  })
})

describe('archiving a pending wake with no prompt', () => {
  it('uses a language-appropriate placeholder title', () => {
    const card = {
      ...createCard('', undefined, 'codex', DEFAULT_CODEX_MODEL),
      title: '',
      wakeTimerQueuedSends: [
        {
          id: 'q1',
          prompt: '',
          attachments: [{ id: 'a1', fileName: 'shot.png', mimeType: 'image/png' as const, sizeBytes: 12 }],
        },
      ],
    }
    const en = archiveCardToHistory([], card, 'D:/Git/demo', undefined, 'en')
    const zh = archiveCardToHistory([], card, 'D:/Git/demo', undefined, defaultAppLanguage)
    assert.equal(en[0]?.title, 'Pending wake message')
    assert.equal(zh[0]?.title, '待唤醒消息')
  })
})
