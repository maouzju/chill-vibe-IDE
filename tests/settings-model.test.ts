import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createDefaultSettings } from '../shared/default-state.ts'
import type { CliCompatStatus } from '../shared/cli-compat.ts'
import type { OnboardingStatus, ProviderStatus } from '../shared/schema.ts'
import {
  deriveEnvironmentHealth,
  filterSettingsItems,
  getBasicSettingsItems,
  getSettingsCategoryItems,
  resolveOnboardingWizardStage,
  settingsCategoryIds,
  settingsItemCatalog,
} from '../src/components/settings/settings-model.ts'

const onboarding = (claude: boolean, codex: boolean): OnboardingStatus => ({
  environment: {
    ready: claude && codex,
    checks: [
      { id: 'git', label: 'Git', available: true },
      { id: 'node', label: 'Node.js', available: true },
      { id: 'claude', label: 'Claude CLI', available: claude },
      { id: 'codex', label: 'Codex CLI', available: codex },
    ],
  },
  ccSwitch: { available: false },
})

const providers = (claude: boolean, codex: boolean): ProviderStatus[] => [
  { provider: 'claude', available: claude },
  { provider: 'codex', available: codex },
]

const compat = (
  overrides: Partial<Record<'claude' | 'codex', Partial<CliCompatStatus['entries'][number]>>> = {},
): CliCompatStatus => ({
  entries: (['claude', 'codex'] as const).map((provider) => ({
    provider,
    compatibleVersion: '1.0.0',
    installed: false,
    active: false,
    activeVersion: null,
    systemVersion: '1.0.0',
    task: null,
    ...overrides[provider],
  })),
})

const withProfile = (provider: 'claude' | 'codex', apiKey = 'sk-test') => {
  const settings = createDefaultSettings()
  settings.providerProfiles[provider] = {
    activeProfileId: 'p1',
    profiles: [{ id: 'p1', name: 'Main', baseUrl: '', apiKey }],
  }
  return settings
}

describe('settings catalog', () => {
  it('assigns every item to exactly one of the six categories with unique ids', () => {
    const ids = settingsItemCatalog.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual(settingsCategoryIds, [
      'get-started',
      'models',
      'appearance',
      'automation',
      'network',
      'system',
    ])
    for (const category of settingsCategoryIds) {
      assert.ok(getSettingsCategoryItems(category).length > 0, `${category} should not be empty`)
    }
  })

  it('only folds rarely-touched items into the advanced drawer', () => {
    // 09-25 用户反馈：完成提示音这类常用开关不该藏进「高级设置」。
    const advanced = settingsItemCatalog.filter((item) => item.tier === 'advanced').map((item) => item.id)
    assert.deepEqual(advanced.sort(), ['cli-compat', 'data', 'experimental', 'local-models', 'repeat-loop'].sort())
  })

  it('keeps the basic view down to language/theme, account, default model and update check', () => {
    // 基础视图的顺序是新手的操作顺序：先看得懂界面，再连账号，再选模型，最后更新。
    assert.deepEqual(
      getBasicSettingsItems().map((item) => item.id),
      ['language-theme', 'account', 'models', 'update'],
    )
  })

  it('pins experimental items after regular ones and the danger zone last in the system category', () => {
    const system = getSettingsCategoryItems('system')
    const firstExperimental = system.findIndex((item) => item.experimental)
    const lastRegular = system.map((item) => !item.experimental && !item.danger).lastIndexOf(true)
    assert.ok(firstExperimental > lastRegular)
    assert.equal(system[system.length - 1]?.danger, true)
    assert.equal(system[system.length - 1]?.id, 'data')
  })

  it('places routing, proxy and safety items under the expected categories', () => {
    const byId = new Map(settingsItemCatalog.map((item) => [item.id, item]))
    assert.equal(byId.get('account')?.category, 'get-started')
    assert.equal(byId.get('codex-safety')?.category, 'network')
    assert.equal(byId.get('wake-timer')?.category, 'automation')
    assert.equal(byId.get('local-models')?.category, 'models')
    assert.equal(byId.get('editor')?.category, 'appearance')
  })

  // 2026-09-23 用户反馈：接口配置/路由/cc-switch 导入/断线代理本就在「接口」选项卡，
  // 设置里再摆一份是重复。设置只留「连接账号」摘要 + 跳转，搜这些词也落到它上面。
  it('does not duplicate items that live in the routing tab', () => {
    const ids = settingsItemCatalog.map((item) => item.id)
    for (const id of ['routing-toggle', 'routing-import', 'resilient-proxy', 'proxy-stats']) {
      assert.ok(!ids.includes(id), `${id} belongs to the routing tab`)
    }
  })

  it('gives jargon items a plain-language hint in both languages', () => {
    for (const id of ['codex-safety', 'account', 'models', 'cli-compat']) {
      const item = settingsItemCatalog.find((entry) => entry.id === id)
      assert.ok(item?.hint?.['zh-CN'], `${id} needs a zh hint`)
      assert.ok(item?.hint?.en, `${id} needs an en hint`)
    }
  })
})

describe('filterSettingsItems', () => {
  it('returns everything for an empty query', () => {
    assert.equal(filterSettingsItems(settingsItemCatalog, '   ').length, settingsItemCatalog.length)
  })

  it('matches english keywords from a chinese ui and vice versa, case-insensitively', () => {
    const proxyHits = filterSettingsItems(settingsItemCatalog, 'PROXY').map((item) => item.id)
    assert.ok(proxyHits.includes('account'))

    const zhHits = filterSettingsItems(settingsItemCatalog, '思考').map((item) => item.id)
    assert.ok(zhHits.includes('models'))

    const reconnectHits = filterSettingsItems(settingsItemCatalog, '断线').map((item) => item.id)
    assert.ok(reconnectHits.includes('account'))
    assert.ok(filterSettingsItems(settingsItemCatalog, 'cc-switch').some((item) => item.id === 'account'))
  })

  it('returns an empty list when nothing matches', () => {
    assert.deepEqual(filterSettingsItems(settingsItemCatalog, 'zzz-no-such-setting'), [])
  })
})

describe('deriveEnvironmentHealth', () => {
  it('reports unknown lights before any probe result arrives', () => {
    const health = deriveEnvironmentHealth({
      onboardingStatus: null,
      providers: [],
      cliCompatStatus: null,
      settings: createDefaultSettings(),
    })
    assert.equal(health.cli.state, 'unknown')
    assert.equal(health.account.state, 'unknown')
    assert.equal(health.version.state, 'unknown')
  })

  it('turns the cli light green only when both CLIs resolve', () => {
    const both = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: null,
      settings: createDefaultSettings(),
    })
    assert.equal(both.cli.state, 'ok')
    assert.equal(both.cli.fix, null)

    const one = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, false),
      providers: providers(true, false),
      cliCompatStatus: null,
      settings: createDefaultSettings(),
    })
    assert.equal(one.cli.state, 'warn')
    assert.deepEqual(one.cli.fix, { kind: 'install-cli' })

    const none = deriveEnvironmentHealth({
      onboardingStatus: onboarding(false, false),
      providers: providers(false, false),
      cliCompatStatus: null,
      settings: createDefaultSettings(),
    })
    assert.equal(none.cli.state, 'error')
    assert.deepEqual(none.cli.fix, { kind: 'install-cli' })
  })

  it('treats an active keyed profile or disabled routing as a usable account', () => {
    const keyed = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: null,
      settings: withProfile('claude'),
    })
    assert.equal(keyed.account.state, 'ok')

    const routingOff = createDefaultSettings()
    routingOff.cliRoutingEnabled = false
    const cliLogin = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: null,
      settings: routingOff,
    })
    assert.equal(cliLogin.account.state, 'ok')

    const missing = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: null,
      settings: withProfile('claude', '   '),
    })
    assert.equal(missing.account.state, 'warn')
    assert.deepEqual(missing.account.fix, { kind: 'connect-account' })
  })

  it('derives the version light from the compat manager and offers the matching fix', () => {
    const base = {
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      settings: createDefaultSettings(),
    }

    const matching = deriveEnvironmentHealth({ ...base, cliCompatStatus: compat() })
    assert.equal(matching.version.state, 'ok')

    const activeCompat = deriveEnvironmentHealth({
      ...base,
      cliCompatStatus: compat({
        claude: { installed: true, active: true, activeVersion: '1.0.0', systemVersion: '0.9.0' },
      }),
    })
    assert.equal(activeCompat.version.state, 'ok')

    const notInstalled = deriveEnvironmentHealth({
      ...base,
      cliCompatStatus: compat({ codex: { systemVersion: '0.9.0' } }),
    })
    assert.equal(notInstalled.version.state, 'warn')
    assert.deepEqual(notInstalled.version.fix, { kind: 'install-compat', provider: 'codex' })

    const installedInactive = deriveEnvironmentHealth({
      ...base,
      cliCompatStatus: compat({
        codex: { installed: true, active: false, activeVersion: null, systemVersion: '0.9.0' },
      }),
    })
    assert.equal(installedInactive.version.state, 'warn')
    assert.deepEqual(installedInactive.version.fix, { kind: 'activate-compat', provider: 'codex' })
  })

  it('ignores providers that are not installed when judging version compatibility', () => {
    const health = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, false),
      providers: providers(true, false),
      cliCompatStatus: compat({ codex: { systemVersion: null } }),
      settings: createDefaultSettings(),
    })
    assert.equal(health.version.state, 'ok')
  })
})

describe('resolveOnboardingWizardStage', () => {
  const ready = {
    statusLoaded: true,
    environmentReady: true,
    setupSkipped: false,
    importState: 'idle' as const,
    accountState: 'idle' as const,
    hasUsableAccount: false,
    modelState: 'idle' as const,
  }

  it('walks loading → setup → account → model → complete', () => {
    assert.equal(resolveOnboardingWizardStage({ ...ready, statusLoaded: false }), 'loading')
    assert.equal(resolveOnboardingWizardStage({ ...ready, environmentReady: false }), 'setup')
    assert.equal(
      resolveOnboardingWizardStage({ ...ready, environmentReady: false, setupSkipped: true }),
      'account',
    )
    assert.equal(resolveOnboardingWizardStage(ready), 'account')
    assert.equal(resolveOnboardingWizardStage({ ...ready, importState: 'imported' }), 'model')
    assert.equal(resolveOnboardingWizardStage({ ...ready, accountState: 'skipped' }), 'model')
    assert.equal(resolveOnboardingWizardStage({ ...ready, accountState: 'connected' }), 'model')
    assert.equal(resolveOnboardingWizardStage({ ...ready, hasUsableAccount: true }), 'model')
    assert.equal(
      resolveOnboardingWizardStage({ ...ready, importState: 'skipped', modelState: 'confirmed' }),
      'complete',
    )
  })
})

// 2026-09-25 另一台电脑报「下载兼容版」点了没用：下载在后台跑、失败原因只闪一下，版本灯一行毫无变化。
// 版本灯要把下载任务透传给 UI：下载中、失败原因都得落在这一行。
describe('deriveEnvironmentHealth compat task', () => {
  const compatEntry = (task: { status: 'running' | 'succeeded' | 'failed'; message: string } | null) => ({
    entries: [
      {
        provider: 'codex' as const,
        compatibleVersion: '0.156.1',
        installed: false,
        active: false,
        activeVersion: null,
        systemVersion: '0.150.0',
        task,
      },
    ],
  })

  it('exposes the running and failed install task on the version light', () => {
    const running = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: compatEntry({ status: 'running', message: '@openai/codex@0.156.1' }),
      settings: createDefaultSettings(),
    })
    assert.equal(running.version.task?.status, 'running')

    const failed = deriveEnvironmentHealth({
      onboardingStatus: onboarding(true, true),
      providers: providers(true, true),
      cliCompatStatus: compatEntry({ status: 'failed', message: 'npm exit 1' }),
      settings: createDefaultSettings(),
    })
    assert.equal(failed.version.task?.status, 'failed')
    assert.equal(failed.version.task?.message, 'npm exit 1')
  })
})
