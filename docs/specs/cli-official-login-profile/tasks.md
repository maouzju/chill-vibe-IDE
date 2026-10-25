# 任务

- [x] 实测 claude 空串 env 覆盖可中和中转站 token；实测 codex forced_login_method 会删 auth.json（已从 cc-switch.db 恢复）
- [x] schema `authMode` + 失败测试（provider-routing-runtime：claude/codex/gemini cli-login 注入）
- [x] resolveProviderRuntime 实现中和注入
- [x] model-discovery 跳过 cli-login
- [x] 健康灯 / 新手引导 / 账号摘要认 cli-login
- [x] 接口选项卡 UI：添加官方会员登录 + 精简卡片
- [x] AGENTS.md 坑位 + 截图验证

## 后续（未做）

- cc-switch 导入时把「Claude Official / OpenAI Official」这类无 key 的官方条目映射成 cli-login 配置。
- 白噪音生成、Git 卡等非聊天路径若不经 `buildClaudeArgs`，Claude 的 settings.json env 仍会赢；它们在会员模式下会继续走全局中转站。
