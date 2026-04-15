import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'

describe('auto urge profile settings', () => {
  it('creates a default named profile and mirrors it to the legacy fields', () => {
    const settings = createDefaultSettings()

    assert.equal(settings.autoUrgeProfiles.length, 1)
    assert.equal(settings.autoUrgeActiveProfileId, settings.autoUrgeProfiles[0]?.id)
    assert.equal(settings.autoUrgeProfiles[0]?.name, '默认鞭策')
    assert.equal(settings.autoUrgeMessage, settings.autoUrgeProfiles[0]?.message)
    assert.equal(settings.autoUrgeSuccessKeyword, settings.autoUrgeProfiles[0]?.successKeyword)
  })

  it('normalizes named profiles and derives the active legacy message fields from the selected profile', () => {
    const settings = normalizeAppSettings({
      autoUrgeEnabled: true,
      autoUrgeProfiles: [
        {
          id: 'profile-dev',
          name: '开发验收',
          message: '继续验证，给出证据。',
          successKeyword: 'DONE',
        },
        {
          id: 'profile-review',
          name: '代码审查',
          message: '继续审查，列出风险。',
          successKeyword: 'APPROVED',
        },
      ],
      autoUrgeActiveProfileId: 'profile-review',
    })

    assert.equal(settings.autoUrgeProfiles.length, 2)
    assert.equal(settings.autoUrgeActiveProfileId, 'profile-review')
    assert.equal(settings.autoUrgeMessage, '继续审查，列出风险。')
    assert.equal(settings.autoUrgeSuccessKeyword, 'APPROVED')
  })

  it('upgrades legacy single-message settings into the new profile list', () => {
    const settings = normalizeAppSettings({
      autoUrgeEnabled: true,
      autoUrgeMessage: '不要停，继续验证。',
      autoUrgeSuccessKeyword: 'YES',
    })

    assert.equal(settings.autoUrgeProfiles.length, 1)
    assert.equal(settings.autoUrgeProfiles[0]?.name, '默认鞭策')
    assert.equal(settings.autoUrgeProfiles[0]?.message, '不要停，继续验证。')
    assert.equal(settings.autoUrgeProfiles[0]?.successKeyword, 'YES')
    assert.equal(settings.autoUrgeActiveProfileId, settings.autoUrgeProfiles[0]?.id)
  })
})
