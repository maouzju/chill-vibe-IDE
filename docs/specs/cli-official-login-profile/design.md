# 设计

## 数据

`providerProfileSchema` 加 `authMode: 'api-key' | 'cli-login'`，默认 `'api-key'`（老数据零迁移）。`cli-login` 的 apiKey/baseUrl 忽略。

## 运行时（server/providers.ts `resolveProviderRuntime`）

路由开 + 活动 profile 为 `cli-login` 时，不再走「apiKey 为空就整段不注入」的短路，而是返回「中和」注入：

| provider | 注入 |
|---|---|
| claude | env 删掉 `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL`；`claudeSettingsEnv` = 三者全为空串，经 `--settings` 压住 `~/.claude/settings.json` 的 env（2026-10-25 实测：空串覆盖后 CLI 回落 OAuth，未登录时报 `Not logged in · Please run /login`） |
| codex | args `-c model_provider="openai"`；env 删掉 `OPENAI_API_KEY/OPENAI_BASE_URL` |
| gemini | env 删掉 `GEMINI_API_KEY/GOOGLE_API_KEY/GOOGLE_GEMINI_BASE_URL` |

**禁用 `forced_login_method="chatgpt"`**：2026-10-25 实测 codex-cli 0.156.1 遇到 auth.json 里是 API key 时会打印 “Logging out” 并删除 auth.json，直接毁掉用户的中转站配置。代价是 auth.json 里是 API key 时会员模式会拿这个 key 打官方 OpenAI（报 401），这是可见、可恢复的错误。

不经过断线续传代理（官方端点不需要，也没有 key 可转发）。模型自动发现（model-discovery）在 cli-login 下跳过（没有 key 可探测）。

## 界面（App.tsx 接口选项卡）

- 草稿卡「添加配置」旁加「添加官方会员登录」按钮，生成 `{ authMode: 'cli-login', name: '官方会员登录' }` 并设为启用。
- cli-login 卡片只显示名称 + 一行说明（登录命令）+ 启用/删除，不显示 key/地址。
- 设置「账号」摘要、环境健康账号灯、新手引导 `hasUsableAccount` 把 cli-login 视为可用。
