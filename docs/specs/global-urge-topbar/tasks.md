# 全员鞭策（Global Urge）— 任务

1. [x] SPEC（requirements / design / tasks）
2. [ ] 红：`tests/auto-urge-settings.test.ts` 新字段断言 + `tests/chat-auto-urge.test.ts` `resolveEffectiveAutoUrge` 断言，先确认失败
3. [ ] 绿：`shared/schema.ts`、`shared/default-state.ts`、`src/state.ts`、`src/components/chat-auto-urge.ts`
4. [ ] UI：设置勾选框、顶部控件、props 链、ChatCard 生效逻辑、i18n、CSS（双主题）
5. [ ] 验证：窄单测 + `pnpm test:quality`；合并回用户分支；清理 worktree；重启活动 runtime
