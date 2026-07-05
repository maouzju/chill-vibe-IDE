import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultSettings, normalizeAppSettings } from '../shared/default-state.ts'
import type { AutoUrgeProfile } from '../shared/schema.ts'

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
        } as AutoUrgeProfile,
        {
          id: 'profile-review',
          name: '代码审查',
          message: '继续审查，列出风险。',
          successKeyword: 'APPROVED',
        } as AutoUrgeProfile,
      ],
      autoUrgeActiveProfileId: 'profile-review',
    })

    assert.equal(settings.autoUrgeProfiles.length, 2)
    assert.equal(settings.autoUrgeActiveProfileId, 'profile-review')
    assert.equal(settings.autoUrgeMessage, '继续审查，列出风险。')
    assert.equal(settings.autoUrgeSuccessKeyword, 'APPROVED')
  })


  it('preserves an explicitly empty auto urge profile message so blank urges can continue', () => {
    const settings = normalizeAppSettings({
      autoUrgeEnabled: true,
      autoUrgeProfiles: [
        {
          id: 'profile-empty',
          name: 'Continue only',
          message: '',
          successKeyword: 'DONE',
        } as AutoUrgeProfile,
      ],
      autoUrgeActiveProfileId: 'profile-empty',
    })

    assert.equal(settings.autoUrgeProfiles[0]?.message, '')
    assert.equal(settings.autoUrgeMessage, '')
    assert.equal(settings.autoUrgeSuccessKeyword, 'DONE')
  })

  it('defaults the global urge control to hidden and inactive', () => {
    const settings = createDefaultSettings()

    assert.equal(settings.autoUrgeGlobalControlEnabled, false)
    assert.equal(settings.autoUrgeGlobalActive, false)
    assert.equal(settings.autoUrgeGlobalProfileId, settings.autoUrgeProfiles[0]?.id)
  })

  it('normalizes legacy saved settings without global urge fields to safe defaults', () => {
    const settings = normalizeAppSettings({
      autoUrgeEnabled: true,
      autoUrgeMessage: '不要停，继续验证。',
      autoUrgeSuccessKeyword: 'YES',
    })

    assert.equal(settings.autoUrgeGlobalControlEnabled, false)
    assert.equal(settings.autoUrgeGlobalActive, false)
    assert.equal(settings.autoUrgeGlobalProfileId, settings.autoUrgeProfiles[0]?.id)
  })

  it('keeps a valid global urge profile id and falls back when the profile is gone', () => {
    const base = {
      autoUrgeEnabled: true,
      autoUrgeProfiles: [
        {
          id: 'profile-dev',
          name: '开发验收',
          message: '继续验证。',
          successKeyword: 'DONE',
          judgeMode: 'keyword' as const,
          judgeModel: '',
        },
        {
          id: 'profile-review',
          name: '代码审查',
          message: '继续审查。',
          successKeyword: 'APPROVED',
          judgeMode: 'keyword' as const,
          judgeModel: '',
        },
      ],
      autoUrgeActiveProfileId: 'profile-dev',
    }

    const kept = normalizeAppSettings({
      ...base,
      autoUrgeGlobalControlEnabled: true,
      autoUrgeGlobalActive: true,
      autoUrgeGlobalProfileId: 'profile-review',
    })
    assert.equal(kept.autoUrgeGlobalControlEnabled, true)
    assert.equal(kept.autoUrgeGlobalActive, true)
    assert.equal(kept.autoUrgeGlobalProfileId, 'profile-review')

    const fallback = normalizeAppSettings({
      ...base,
      autoUrgeGlobalProfileId: 'profile-removed',
    })
    assert.equal(fallback.autoUrgeGlobalProfileId, 'profile-dev')
  })

  it('defaults new judge fields to keyword mode and normalizes invalid judge modes', () => {
    const defaults = createDefaultSettings()
    assert.equal(defaults.autoUrgeProfiles[0]?.judgeMode, 'keyword')
    assert.equal(defaults.autoUrgeProfiles[0]?.judgeModel, '')

    const settings = normalizeAppSettings({
      autoUrgeEnabled: true,
      autoUrgeProfiles: [
        {
          id: 'profile-llm',
          name: '模型判定',
          message: '继续。',
          successKeyword: '',
          judgeMode: 'local-model',
          judgeModel: 'qwen3:4b',
        },
        {
          id: 'profile-bad',
          name: '坏模式',
          message: '继续。',
          successKeyword: 'DONE',
          judgeMode: 'cloud-magic' as AutoUrgeProfile['judgeMode'],
          judgeModel: '',
        },
      ],
      autoUrgeActiveProfileId: 'profile-llm',
    })

    assert.equal(settings.autoUrgeProfiles[0]?.judgeMode, 'local-model')
    assert.equal(settings.autoUrgeProfiles[0]?.judgeModel, 'qwen3:4b')
    assert.equal(settings.autoUrgeProfiles[1]?.judgeMode, 'keyword')
    assert.equal(settings.autoUrgeProfiles[1]?.judgeModel, '')
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
