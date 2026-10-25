# 官方会员登录配置（cli-official-login-profile）

## 背景

2026-10-25 用户问：Claude CLI / Codex CLI 是不是该支持「会员」配置模式（Claude Pro/Max 订阅、ChatGPT Plus/Pro 登录，即 CLI 自己的 OAuth 登录）。

现状：
- 只有一个全局「接口路由」开关。关掉 = 所有 provider 都用 CLI 自己的全局配置；开着 = 用各自的 API key profile。没法「Claude 走会员、Codex 走中转站」。
- 更关键的是：用户（以及大量 cc-switch 用户）的全局配置本身就写死了中转站——`~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN/BASE_URL`、`~/.codex/config.toml` 的 `model_provider = "duckcoding"`。这时就算关掉路由、`claude /login` 登了会员，CLI 照样走中转站。会员登录在今天的 IDE 里实际上用不了。

## 需求

1. 每个 provider（Claude / Codex / Gemini）的接口配置里可以添加一条「官方会员登录」配置，和 API key 配置并列，可启用、可删除。
2. 启用它时，该 provider 的会话使用 CLI 自己登录的官方账号（`claude /login`、`codex login`、Gemini 的 Google 登录），并且**压掉**全局配置里的中转站 token / 地址 / model_provider，不需要用户手改 `~/.claude`、`~/.codex`。
3. 不影响其它 provider：Claude 用会员时 Codex 仍可走 API key 配置，反之亦然。
4. 不修改、不删除用户的 `~/.codex/auth.json`、`~/.claude/settings.json`。
5. 环境健康卡/新手引导把「启用了官方会员登录」视为账号可用。
6. 没登录会员时，CLI 自己的报错（如 `Not logged in · Please run /login`）原样露出，界面提示要先在终端里登录。

## 非目标

- 不在 IDE 里代办 OAuth 登录流程（登录仍在终端里跑 `claude /login` / `codex login`）。
- 不做会员额度查询。
