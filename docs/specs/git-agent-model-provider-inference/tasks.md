# Git 卡片 AI 模型按模型名选择 CLI — 任务

- [x] 先红：`tests/models.test.ts` 覆盖 `inferProviderFromModel`（目录 id、别名、中转站名、认不出返回 null）。
- [x] 先红：`tests/git-operation-hub.test.ts` 覆盖分析请求 / 冲突会话按模型名选 CLI、档位规范化、
      Codex 专属字段只发给 Codex、分析请求 `readOnly`。
- [x] 先红：别名 / 多词标签 / 错拼档位 / Codex 档位透传（`resolveGitAgentModel` 用例）。
- [x] 先红：Claude 回答 JSON 前有带 `{` 的旁白仍能解析。
- [x] 实现 `inferProviderFromModel` 与 `resolveGitAgentModel`，接入分析请求与冲突会话。
- [x] `readOnly` 贯通：schema、Codex 沙箱、Claude dontAsk + deny（含 keepalive 签名）、Gemini default 审批；
      `tests/provider-system-prompt.test.ts`、`tests/claude-keepalive-signature.test.ts`、
      `tests/gemini-provider.test.ts` 覆盖。
- [x] 真机：Claude CLI 2.1.280 验证 dontAsk 单独挡不住写、加 deny 后只读。
- [x] 设置项旁显示识别出的 CLI 标签；更新中英文说明文案。
- [x] Playwright：`tests/theme-check.spec.ts` 新增标签随输入变化 + 暗/亮快照，
      更新 `interface-request-settings-group-*` 快照。
- [x] AGENTS.md Known Pitfalls #404；更新 `docs/specs/git-sync-conflict-session/design.md`。
