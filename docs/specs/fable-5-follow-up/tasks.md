# Fable 5 功能跟进 — 任务

- [x] T1 红测试：models / reasoning / provider-system-prompt 三个测试面按 design §6 写入新断言，运行确认失败
- [x] T2 shared 实现：`shared/models.ts` 模型表、`shared/reasoning.ts` 模型感知函数、`shared/default-state.ts` createCard 默认（额外覆盖 `getPreferredReasoningEffort` / `rememberModelReasoningEffort` / 设置恢复归一化三处模型感知）
- [x] T3 server 实现：`buildClaudeArgs` 档位出口 + settings.ultracode + 移除关键词注入（keepalive 池签名注释同步更新）
- [x] T4 UI 实现：ChatCard 档位菜单/思考开关模型感知
- [x] T5 验证：reasoning/models/provider 窄测试 + 157 个相关单测全绿 + `pnpm test:quality` 通过；本机 CLI（2.1.174）smoke：`--settings '{"ultracode":true}'` 成功、`--model claude-sonnet-5` 透传成功（版本门槛只影响 picker，见 AGENTS.md pitfall）
- [x] T6 合并回 main、复跑窄测试、清理 worktree、按需重启活跃 runtime
