# Requirements: Model Prompt Rules

## Goal

- 在设置里新增 **“基于模型的提示词”**，让用户可以按模型关键字配置额外系统提示词。
- 这些规则应在发送请求时自动附加到原有全局系统提示词后面，例如填写 `claude` 时，所有 Claude 模型都自动追加对应规则。
- 规则编辑放在一个 **二级页面/弹层** 里完成，主设置页只展示入口和摘要，避免设置面板过长。

## User Stories

- As a user, I can open Settings → Models and see a “基于模型的提示词 / Model prompt rules” entry.
- As a user, I can enter the secondary editor, add / edit / delete rules, and each rule includes:
  - a model keyword used for matching
  - the prompt text to append when matched
- As a user, if I configure a rule with keyword `claude`, then models such as `claude-sonnet-4-6` or `claude-opus-4-7` automatically receive that extra prompt.
- As a user, if multiple rules match the same model, the matched prompts are appended in list order after the base system prompt.
- As a user, if a rule is incomplete (empty keyword or empty prompt), it should not be persisted as an active rule.

## Acceptance Criteria

- [ ] Settings → Models shows a new entry for model-based prompt rules with a summary/count and an edit action.
- [ ] Clicking the entry opens a secondary editor dialog/page dedicated to rule management.
- [ ] A rule matches a model by **case-insensitive substring** on the final request model name.
- [ ] Matched prompt text is appended after the base system prompt before provider execution.
- [ ] Existing request flows honor the rules, including:
  - normal chat sends / resumes / stream recovery
  - brainstorm requests
  - Git agent / Git sync automation requests
- [ ] Empty or whitespace-only rules are ignored during normalization/persistence.
- [ ] Existing saved state upgrades safely with an empty rule list by default.
- [ ] The new UI remains legible in both light and dark themes.

## Out of Scope

- Regex matching or provider-only matching in this first slice.
- Rule enable/disable toggles, drag sorting, import/export, or per-workspace overrides.
- Separate prompt-rule systems for slash commands or non-chat background services.
