import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDefaultState } from '../shared/default-state.ts'
import { mergeImportedProviderProfiles } from '../shared/provider-profile-import.ts'
import type { AppSettings } from '../shared/schema.ts'

type RestorableEnvVar =
  | 'OPENAI_API_KEY'
  | 'OPENAI_BASE_URL'
  | 'ANTHROPIC_API_KEY'
  | 'ANTHROPIC_AUTH_TOKEN'
  | 'ANTHROPIC_BASE_URL'

const restoreEnvVar = (name: RestorableEnvVar, value: string | undefined) => {
  if (typeof value === 'string') {
    process.env[name] = value
    return
  }

  delete process.env[name]
}

describe('provider runtime routing', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `chill-vibe-provider-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(tmpDir, { recursive: true })
    process.env.CHILL_VIBE_DATA_DIR = tmpDir
  })

  afterEach(async () => {
    delete process.env.CHILL_VIBE_DATA_DIR
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('does not inject provider profile settings when both CLI routing and resilient proxy are disabled', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime } = await import('../server/providers.ts')
    const state = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    state.settings.cliRoutingEnabled = false
    state.settings.resilientProxyEnabled = false
    state.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    await saveState(state)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.deepEqual(runtime.args, [])
      assert.equal(runtime.env.OPENAI_API_KEY, undefined)
      assert.equal(runtime.env.OPENAI_BASE_URL, undefined)
      assert.notEqual(runtime.env.OPENAI_API_KEY, 'sk-codex')
      assert.notEqual(runtime.env.OPENAI_BASE_URL, 'https://codex.example/v1')
    } finally {
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })

  it('does not inject provider profile settings when only resilient proxy is enabled (CLI routing controls injection)', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime } = await import('../server/providers.ts')
    const state = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    state.settings.cliRoutingEnabled = false
    state.settings.resilientProxyEnabled = true
    state.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    await saveState(state)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.deepEqual(runtime.args, [])
      assert.equal(runtime.env.OPENAI_API_KEY, undefined)
      assert.equal(runtime.env.OPENAI_BASE_URL, undefined)
    } finally {
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })

  it('prefers staged runtime settings over stale persisted routing settings before the next save flushes', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import('../server/providers.ts')
    const persistedState = createDefaultState('')
    const stagedState = createDefaultState('')
    const originalOpenAiApiKey = process.env.OPENAI_API_KEY
    const originalOpenAiBaseUrl = process.env.OPENAI_BASE_URL

    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL

    persistedState.settings.cliRoutingEnabled = false
    await saveState(persistedState)

    stagedState.settings.cliRoutingEnabled = true
    stagedState.settings.resilientProxyEnabled = false
    stagedState.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    setProviderRuntimeSettingsOverride(stagedState.settings)

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.equal(runtime.env.OPENAI_API_KEY, 'sk-codex')
      assert.equal(runtime.env.OPENAI_BASE_URL, 'https://codex.example/v1')
      assert.notDeepEqual(runtime.args, [])
    } finally {
      setProviderRuntimeSettingsOverride(null)
      restoreEnvVar('OPENAI_API_KEY', originalOpenAiApiKey)
      restoreEnvVar('OPENAI_BASE_URL', originalOpenAiBaseUrl)
    }
  })

  it('passes resilient proxy timeout and retry settings into the runtime proxy', async () => {
    const { saveState } = await import('../server/state-store.ts')
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import('../server/providers.ts')
    const { resilientProxyPool } = await import('../server/resilient-proxy.ts')
    const state = createDefaultState('')
    const originalResolveBaseUrl = resilientProxyPool.resolveBaseUrl.bind(resilientProxyPool)
    const captured: Array<{ provider: string; baseUrl: string; config: unknown }> = []

    state.settings.cliRoutingEnabled = true
    state.settings.resilientProxyEnabled = true
    state.settings.resilientProxyStallTimeoutSec = 123
    state.settings.resilientProxyFirstByteTimeoutSec = 234
    state.settings.resilientProxyMaxRetries = -1
    state.settings.providerProfiles.codex = {
      activeProfileId: 'codex-profile-1',
      profiles: [
        {
          id: 'codex-profile-1',
          name: 'Codex Proxy',
          apiKey: 'sk-codex',
          baseUrl: 'https://codex.example/v1',
        },
      ],
    }

    await saveState(state)
    setProviderRuntimeSettingsOverride(state.settings)

    resilientProxyPool.resolveBaseUrl = (async (provider, baseUrl, config) => {
      captured.push({ provider, baseUrl, config })
      return 'http://127.0.0.1:43210/v1'
    }) as typeof resilientProxyPool.resolveBaseUrl

    try {
      const runtime = await resolveProviderRuntime('codex')

      assert.equal(runtime.env.OPENAI_BASE_URL, 'http://127.0.0.1:43210/v1')
      assert.deepEqual(captured, [
        {
          provider: 'codex',
          baseUrl: 'https://codex.example/v1',
          config: {
            firstByteTimeoutMs: 234_000,
            stallTimeoutMs: 123_000,
            maxRecoveryRetries: -1,
          },
        },
      ])
    } finally {
      resilientProxyPool.resolveBaseUrl = originalResolveBaseUrl
      setProviderRuntimeSettingsOverride(null)
    }
  })

})

describe('cc-switch provider profile import merge', () => {
  it('preserves existing secrets when a re-import omits the api key and keeps the current usable profile active', () => {
    const result = mergeImportedProviderProfiles(
      {
        activeProfileId: 'cc-switch:codex:default',
        profiles: [
          {
            id: 'cc-switch:codex:default',
            name: 'Codex Proxy',
            apiKey: 'sk-existing',
            baseUrl: 'https://codex.example/v1',
          },
        ],
      },
      'codex',
      [
        {
          sourceId: 'default',
          provider: 'codex',
          name: 'Codex Proxy',
          apiKey: '',
          baseUrl: '',
          active: true,
        },
      ],
    )

    assert.equal(result.collection.activeProfileId, 'cc-switch:codex:default')
    assert.deepEqual(result.collection.profiles, [
      {
        id: 'cc-switch:codex:default',
        name: 'Codex Proxy',
        apiKey: 'sk-existing',
        baseUrl: 'https://codex.example/v1',
      },
    ])
  })

  it('does not switch the active profile to a newly imported entry that lacks an api key', () => {
    const result = mergeImportedProviderProfiles(
      {
        activeProfileId: 'manual-codex',
        profiles: [
          {
            id: 'manual-codex',
            name: 'Manual Codex',
            apiKey: 'sk-manual',
            baseUrl: 'https://manual.example/v1',
          },
        ],
      },
      'codex',
      [
        {
          sourceId: 'default',
          provider: 'codex',
          name: 'Codex Import',
          apiKey: '',
          baseUrl: 'https://codex.example/v1',
          active: true,
        },
      ],
    )

    assert.equal(result.collection.activeProfileId, 'manual-codex')
    assert.deepEqual(result.collection.profiles, [
      {
        id: 'manual-codex',
        name: 'Manual Codex',
        apiKey: 'sk-manual',
        baseUrl: 'https://manual.example/v1',
      },
      {
        id: 'cc-switch:codex:default',
        name: 'Codex Import',
        apiKey: '',
        baseUrl: 'https://codex.example/v1',
      },
    ])
  })

  // 这三条一律走 setProviderRuntimeSettingsOverride 注入，不落盘。
  // 2026-08-23 实测：走 saveState 时 CHILL_VIBE_DATA_DIR 对已被 import 的 state-store 不再生效，
  // 测试会读到开发机 .chill-vibe/state.json 里的真实中转站配置（断言里冒出 api.duckcoding.ai）。
  const stageSettings = (localModelEntries: AppSettings['localModelEntries']) => {
    const state = createDefaultState('')
    state.settings.cliRoutingEnabled = true
    state.settings.resilientProxyEnabled = false
    state.settings.providerProfiles.claude = {
      activeProfileId: 'claude-cloud',
      profiles: [
        { id: 'claude-cloud', name: 'Cloud', apiKey: 'sk-cloud', baseUrl: 'https://cloud.example' },
      ],
    }
    state.settings.localModelEntries = localModelEntries
    return state.settings
  }

  const localEntry = {
    id: 'local-1',
    label: '本机 Qwen',
    harness: 'claude' as const,
    baseUrl: 'http://127.0.0.1:11434',
    apiKey: 'local',
    model: 'qwen3-coder:30b',
  }

  // 本地模型条目要逐卡生效：传了条目就必须用条目的端点，而不是全局 active profile。
  // 否则「这张卡用本地模型、那张卡用云端」根本无法成立（需求 #4）。
  it('routes a local model entry to its own endpoint instead of the active profile', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(stageSettings([localEntry]))

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'local-1' })

      assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
      assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'local')
      assert.equal(runtime.env.ANTHROPIC_API_KEY, 'local')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 用户只该被要求填「驱动方式」和「模型名」两项。地址与密钥留空时后端自己补：
  // 本机 Ollama 的默认地址，且 codex 要带 /v1 而 claude 填到主机根 —— 让用户去记这个差异
  // 是纯粹的负担（填错的表现是 404 /responses，根本看不出是少了 /v1）。
  it('fills in the local Ollama endpoint when the entry leaves base url blank', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(
      stageSettings([
        { ...localEntry, id: 'claude-blank', harness: 'claude', baseUrl: '', apiKey: '' },
      ]),
    )

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'claude-blank' })
      assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
      // 空 apiKey 不能让整段注入被 `if (!apiKey)` 短路吃掉 —— 本地服务本来就不校验密钥。
      assert.ok(runtime.env.ANTHROPIC_AUTH_TOKEN)
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  it('adds the /v1 suffix for blank codex local entries', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(
      stageSettings([
        { ...localEntry, id: 'codex-blank', harness: 'codex', baseUrl: '', apiKey: '' },
      ]),
    )

    try {
      const runtime = await resolveProviderRuntime('codex', { localModelId: 'codex-blank' })
      assert.equal(runtime.env.OPENAI_BASE_URL, 'http://127.0.0.1:11434/v1')
      assert.ok(runtime.env.OPENAI_API_KEY)
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  it('still honours an explicitly configured base url', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(
      stageSettings([{ ...localEntry, baseUrl: 'http://192.168.1.9:1234' }]),
    )

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'local-1' })
      assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://192.168.1.9:1234')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 症状：用户加好本地模型后被一条橙色警告告知"CLI 路由当前是关闭的，本地模型同样不会生效"，
  //   要用本机模型就得先去开一个跟它无关的全局开关。
  // 根因：`if (!settings.cliRoutingEnabled) return baseEnv` 这个早退排在本地条目解析**之前**，
  //   顺手把本地模型一起短路了。但两者管的根本不是一回事——cliRoutingEnabled 决定"要不要用
  //   应用内接口配置去覆盖 CLI 自带的全局配置"，而选中一个本地模型条目本身就是逐卡的显式
  //   指定，用户已经表达完意图了，不该再要求他打开一个全局开关。
  // 为什么不能换写法：不能把早退挪到后面了事——非本地模型的路径必须保持"路由关了就完全不注入"，
  //   否则会拿应用内的云端 key 去覆盖用户 ~/.codex/config.toml 里自己配的东西。
  it('routes local model entries even when cli routing is switched off', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    const settings = stageSettings([localEntry])
    settings.cliRoutingEnabled = false
    setProviderRuntimeSettingsOverride(settings)

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'local-1' })

      assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
      assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'local')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 反向守卫：放开本地模型不等于放开一切。没选本地模型时，路由关闭仍然必须一个字节都不注入。
  it('still injects nothing for non-local models when cli routing is off', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    const settings = stageSettings([localEntry])
    settings.cliRoutingEnabled = false
    setProviderRuntimeSettingsOverride(settings)

    try {
      const runtime = await resolveProviderRuntime('claude')
      // 不能断言 undefined：跑测试的进程自己可能带着 ANTHROPIC_BASE_URL（开发机就有），
      // 而"路由关闭"的语义恰恰是**保留** CLI/环境自带的配置。要守的是"没注入应用内那份"。
      assert.notEqual(runtime.env.ANTHROPIC_BASE_URL, 'https://cloud.example')
      assert.notEqual(runtime.env.ANTHROPIC_AUTH_TOKEN, 'sk-cloud')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 条目查不到时**不能**回落到 active profile：那等于拿用户的云端 key 去跑他以为在本地跑的东西。
  // 路由关闭这条新路径同样要守住这个性质。
  it('never falls back to the cloud profile when a local entry id is missing', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    const settings = stageSettings([localEntry])
    settings.cliRoutingEnabled = false
    setProviderRuntimeSettingsOverride(settings)

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'no-such-entry' })
      assert.notEqual(runtime.env.ANTHROPIC_BASE_URL, 'https://cloud.example')
      assert.notEqual(runtime.env.ANTHROPIC_AUTH_TOKEN, 'sk-cloud')
      // 也不能悄悄用上另一个本地条目的地址
      assert.notEqual(runtime.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:11434')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 守住一条被实测推翻的"优化"：不要给本地条目注入 wire_api。
  // 2026-08-23 实测（codex CLI 当日版本）：`wire_api = "chat"` 已被移除，注入后 CLI 直接死在
  // 配置解析上，连启动都做不到。看到本地服务报 404 /responses 时的正确反应是改用 Claude
  // harness，而不是回头来这里加 wire_api。
  it('never injects a wire api override for codex local model entries', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(
      stageSettings([{ ...localEntry, harness: 'codex', baseUrl: 'http://127.0.0.1:11434/v1' }]),
    )

    try {
      const runtime = await resolveProviderRuntime('codex', { localModelId: 'local-1' })
      const providerConfig = runtime.args.find((arg) => arg.includes('model_providers.'))

      assert.ok(providerConfig, 'codex runtime should declare a model provider override')
      assert.doesNotMatch(providerConfig, /wire_api/)
      assert.equal(runtime.env.OPENAI_BASE_URL, 'http://127.0.0.1:11434/v1')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  it('keeps using the active profile when no local model entry is requested', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    setProviderRuntimeSettingsOverride(stageSettings([localEntry]))

    try {
      const runtime = await resolveProviderRuntime('claude')

      assert.equal(runtime.env.ANTHROPIC_BASE_URL, 'https://cloud.example')
      assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, 'sk-cloud')
    } finally {
      setProviderRuntimeSettingsOverride(null)
    }
  })

  // 条目被删掉后仍有卡片指向它：不能注入端点，更不能静默回落到云端 profile
  // ——那等于拿用户的云端 key 去跑他以为在本地跑的东西。
  // 注意必须先清掉宿主的 ANTHROPIC_*：baseEnv 继承 process.env，而开发机上这几个变量
  // 常常本来就指着某个中转站（2026-08-23 实测断言里冒出 api.duckcoding.ai）。
  it('injects nothing when the requested local model entry is gone', async () => {
    const { resolveProviderRuntime, setProviderRuntimeSettingsOverride } = await import(
      '../server/providers.ts'
    )
    const originalBaseUrl = process.env.ANTHROPIC_BASE_URL
    const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN
    const originalApiKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    setProviderRuntimeSettingsOverride(stageSettings([]))

    try {
      const runtime = await resolveProviderRuntime('claude', { localModelId: 'missing' })

      assert.equal(runtime.env.ANTHROPIC_BASE_URL, undefined)
      assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, undefined)
    } finally {
      setProviderRuntimeSettingsOverride(null)
      restoreEnvVar('ANTHROPIC_BASE_URL', originalBaseUrl)
      restoreEnvVar('ANTHROPIC_AUTH_TOKEN', originalAuthToken)
      restoreEnvVar('ANTHROPIC_API_KEY', originalApiKey)
    }
  })
})
