import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AUTOMATIONBOARD_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_GIT_AGENT_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STATS_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
  getModelOptions,
  isModelPickerOptionVisible,
  isToolCardModel,
  normalizeModel,
  normalizeStoredModel,
  resolveSlashModel,
  resolveSlashModelInput,
} from '../shared/models.ts'

describe('model helpers', () => {
  it('uses the current Codex 5.6 defaults for new agent and Git chats', () => {
    assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol')
    assert.equal(DEFAULT_GIT_AGENT_MODEL, 'gpt-5.6-terra medium')
  })

  it('uses Opus 5 as the Claude default', () => {
    assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-opus-5')
  })

  it('resolves configured defaults and preserves stored default selections', () => {
    assert.equal(normalizeStoredModel('codex', ''), '')
    assert.equal(normalizeModel('codex', ''), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeModel('codex', 'gpt-4.5'), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeModel('codex', 'gpt-5.4'), 'gpt-5.4')
    assert.equal(normalizeStoredModel('codex', '__dream_tool__'), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeStoredModel('codex', '__spec_tool__'), DEFAULT_CODEX_MODEL)
    assert.equal(normalizeStoredModel('claude', ''), '')
    assert.equal(normalizeModel('claude', ''), DEFAULT_CLAUDE_MODEL)
    assert.equal(normalizeModel('claude', ' claude-opus-4-7 '), 'claude-opus-4-7')
    // Opus 4.8 is still a live model: an explicitly stored value must not be
    // migrated onto the newer default (Pitfall #119).
    assert.equal(normalizeModel('claude', ' claude-opus-4-8 '), 'claude-opus-4-8')
    assert.equal(normalizeModel('claude', ' claude-opus-5 '), DEFAULT_CLAUDE_MODEL)
  })

  it('lists Git tool first among codex model options', () => {
    const codexOptions = getModelOptions('codex')
    assert.equal(codexOptions[0].model, GIT_TOOL_MODEL, 'Git tool option must be first')
  })

  it('lists configured-default entries before provider-specific model options', () => {
    assert.deepEqual(
      getModelOptions('codex').map((option) => option.model),
      [
        GIT_TOOL_MODEL,
        MUSIC_TOOL_MODEL,
        WHITENOISE_TOOL_MODEL,
        WEATHER_TOOL_MODEL,
        STICKYNOTE_TOOL_MODEL,
        FILETREE_TOOL_MODEL,
        BRAINSTORM_TOOL_MODEL,
        TEXTEDITOR_TOOL_MODEL,
        IMAGEEDITOR_TOOL_MODEL,
        AUTOMATIONBOARD_TOOL_MODEL,
        STATS_TOOL_MODEL,
        '',
        DEFAULT_CODEX_MODEL,
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
      ],
    )
    assert.deepEqual(
      getModelOptions('claude').map((option) => option.model),
      [
        '',
        'claude-fable-5',
        DEFAULT_CLAUDE_MODEL,
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ],
    )
  })

  it('resolves Fable 5 and Sonnet 5 aliases while keeping Sonnet 4.6 pinned', () => {
    assert.equal(resolveSlashModel('claude', 'fable'), 'claude-fable-5')
    assert.equal(resolveSlashModel('claude', 'fable-5'), 'claude-fable-5')
    assert.equal(resolveSlashModel('claude', 'claude-fable-5'), 'claude-fable-5')
    // Bare "sonnet" follows the official Claude Code alias to Sonnet 5.
    assert.equal(resolveSlashModel('claude', 'sonnet'), 'claude-sonnet-5')
    assert.equal(resolveSlashModel('claude', 'sonnet-5'), 'claude-sonnet-5')
    // Sonnet 4.6 is still a live model: exact names keep working, and stored
    // values must not be migrated (Pitfall #119).
    assert.equal(resolveSlashModel('claude', 'sonnet-4.6'), 'claude-sonnet-4-6')
    assert.equal(resolveSlashModel('claude', 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
    assert.equal(normalizeModel('claude', 'claude-sonnet-4-6'), 'claude-sonnet-4-6')
  })

  it('keeps tool cards out of the ordinary model picker', () => {
    assert.deepEqual(
      getModelOptions('codex')
        .filter(isModelPickerOptionVisible)
        .map((option) => option.model),
      ['', DEFAULT_CODEX_MODEL, 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    )
  })

  // 症状（要防的）：打开某张工具卡后，之后新建的每一张卡都变成那张工具卡且一片空白。
  // 根因：新工具模型漏进 TOOL_CARD_MODELS 时，"切到该卡"会被当成用户选了一个真模型，
  //   写进 settings.requestModels / column.model，新建 tab 再原样继承回来（pitfall 263）。
  // 所以每个工具模型都必须同时满足这三条，加一个工具卡就在这里加一行。
  it('treats every tool model as a tool card, not as a real model', () => {
    for (const model of [
      GIT_TOOL_MODEL,
      MUSIC_TOOL_MODEL,
      WHITENOISE_TOOL_MODEL,
      WEATHER_TOOL_MODEL,
      STICKYNOTE_TOOL_MODEL,
      FILETREE_TOOL_MODEL,
      BRAINSTORM_TOOL_MODEL,
      TEXTEDITOR_TOOL_MODEL,
      IMAGEEDITOR_TOOL_MODEL,
      AUTOMATIONBOARD_TOOL_MODEL,
      STATS_TOOL_MODEL,
    ]) {
      assert.equal(isToolCardModel(model), true, `${model} must be in TOOL_CARD_MODELS`)
      assert.equal(isModelPickerOptionVisible({ model }), false, `${model} must stay out of the picker`)
      // 白名单命中是合法的（`/model git` 就该切到 Git 卡）；要防的是它被当成
      // 用户自定义的真模型名，那条路才会把令牌写进 settings/column 造出空壳卡。
      assert.notEqual(
        resolveSlashModelInput('codex', model)?.custom,
        true,
        `/model ${model} must never resolve through the custom path`,
      )
    }
  })

  it('resolves slash-command aliases to canonical model names', () => {
    assert.equal(resolveSlashModel('codex', 'gpt'), '')
    assert.equal(resolveSlashModel('codex', '5.6'), DEFAULT_CODEX_MODEL)
    assert.equal(resolveSlashModel('codex', 'terra'), 'gpt-5.6-terra')
    assert.equal(resolveSlashModel('codex', 'luna'), 'gpt-5.6-luna')
    assert.equal(resolveSlashModel('codex', '5.5'), 'gpt-5.5')
    assert.equal(resolveSlashModel('codex', 'git'), GIT_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'files'), FILETREE_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'brainstorm'), BRAINSTORM_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'ideas'), BRAINSTORM_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'dream'), null)
    assert.equal(resolveSlashModel('codex', 'reflection'), null)
    assert.equal(resolveSlashModel('codex', 'editor'), TEXTEDITOR_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'image'), IMAGEEDITOR_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'spec'), null)
    assert.equal(resolveSlashModel('codex', 'spec-first'), null)
    assert.equal(resolveSlashModel('codex', 'whitenoise'), WHITENOISE_TOOL_MODEL)
    assert.equal(resolveSlashModel('codex', 'ambient'), WHITENOISE_TOOL_MODEL)
    assert.equal(resolveSlashModel('claude', 'claude'), '')
    // Bare "opus" follows the newest Opus tier, the same way bare "sonnet"
    // moved to Sonnet 5.
    assert.equal(resolveSlashModel('claude', 'opus'), DEFAULT_CLAUDE_MODEL)
    assert.equal(resolveSlashModel('claude', 'opus 5'), DEFAULT_CLAUDE_MODEL)
    assert.equal(resolveSlashModel('claude', 'claude-opus-5'), DEFAULT_CLAUDE_MODEL)
    assert.equal(resolveSlashModel('claude', 'opus 4.8'), null)
    assert.equal(resolveSlashModel('claude', 'claude-opus-4-8'), null)
    assert.equal(resolveSlashModel('claude', 'unknown-model'), null)
  })

  // 症状：2026-08-14 用户的两名同事「很久都用不了 codex」，报错是服务商回的
  //   `unknown provider for model gpt-5.6-sol`——那正是本应用硬编码的默认模型。
  // 根因：内置模型列表是我们维护的几个官方模型，而绝大多数用户接的是中转站，模型名由
  //   服务商决定。旧实现下 `/model gpt-5.4` 被判「未知模型」直接拒掉，下拉里也只有
  //   5.6 三兄弟 + 5.5，于是服务商不上架这几个的用户开箱即死、且无路可走。
  // 为什么不能因为"怕拼错"继续拒：拼错的代价是发出去后服务商报一句错，而拒绝的代价是
  //   这个人永远用不了。两者不对称。
  it('accepts a provider-specific model name that is not in the built-in list', () => {
    assert.deepEqual(resolveSlashModelInput('codex', 'gpt-5.4'), { model: 'gpt-5.4', custom: true })
    assert.deepEqual(resolveSlashModelInput('codex', ' gpt-5-codex '), {
      model: 'gpt-5-codex',
      custom: true,
    })
    assert.deepEqual(resolveSlashModelInput('claude', 'claude-opus-4-8'), {
      model: 'claude-opus-4-8',
      custom: true,
    })
  })

  // 工具卡令牌走的是白名单命中（`/model git` 一直合法，切到 Git 工具卡），自定义那条路
  // 则绝不能产出工具卡模型——否则会造出空壳卡，见 TOOL_CARD_MODELS 上方的注释。
  it('never invents a tool-card model through the custom path', () => {
    assert.deepEqual(resolveSlashModelInput('codex', GIT_TOOL_MODEL), {
      model: GIT_TOOL_MODEL,
      custom: false,
    })
  })

  it('still resolves built-in aliases without flagging them as custom', () => {
    assert.deepEqual(resolveSlashModelInput('codex', 'sol'), {
      model: DEFAULT_CODEX_MODEL,
      custom: false,
    })
    assert.deepEqual(resolveSlashModelInput('codex', 'codex'), { model: '', custom: false })
    assert.deepEqual(resolveSlashModelInput('claude', 'opus'), {
      model: DEFAULT_CLAUDE_MODEL,
      custom: false,
    })
  })

  // 空输入命中的是 `model: ''` 的「跟随配置默认」项，这是既有行为；App.tsx 的 'model'
  // 分支也先用 `!parsed.args` 拦掉了空参数走列表提示，所以这里只钉"形状明显不是模型名"。
  it('refuses input that cannot be a model name', () => {
    assert.equal(resolveSlashModelInput('codex', 'a'), null)
    assert.equal(resolveSlashModelInput('codex', 'model name with spaces'), null)
    assert.equal(resolveSlashModelInput('codex', 'rm -rf /'), null)
    assert.equal(resolveSlashModelInput('codex', 'x'.repeat(200)), null)
  })
})
