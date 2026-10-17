# Git 卡片 AI 模型按模型名选择 CLI — 需求

## 背景

设置里的「Git 卡片 AI 模型」是一行自由文本 `<模型> [推理强度]`，供 Git 工具卡的 AI 提交分析和
同步冲突会话使用。2026-10-17 用户填了 `claude-sonnet-5-5`，但 Git 卡写死 `provider: 'codex'`，
把 Claude 模型发给了 Codex CLI，还带着只有 Codex 认的 `sandboxMode` / `personality` / `serviceTier`。

## 需求

1. Git 卡根据模型名自动判断归属 Codex / Claude / Gemini CLI，分析请求与冲突会话都走该 CLI。
2. 能认出的名字：模型目录里的正式 id、标签（含多词标签如 `Sonnet 5.5`、`Gemini 3.1 Pro`）、别名
   （如 `sonnet`、`opus`、`luna`、`flash`），以及目录外的中转站 / 自定义名按家族关键字归属
   （`claude-*`、`anthropic/...`、`gpt-*`、`o3-*`、`openai/...`、`gemini-*`、`google/gemini-...`），
   大小写与首尾空白不敏感。
3. 目录能认出的别名 / 标签规范化成正式 id 再发给 CLI（`Gemini 3.1 Pro` → `gemini-3.1-pro-preview`）；
   目录外的名字原样透传。
4. 认不出的名字（如 `deepseek-v3`、同时含两族关键字的名字）维持旧行为走 Codex，不报错。
5. 只写 CLI 名（`claude` / `gemini` / `codex` / `gpt`）时，模型留空交给该 CLI 自己的默认模型。
6. 推理强度：只有末尾词是任一 CLI 的合法档位才当强度；写错的（如 `hgih`）丢掉、按默认 `medium`。
   Claude / Gemini 按各自档位表规范化（Claude 没有 `ultra` → `max`；Gemini 只有 `auto`）；
   Codex 原样透传（Codex 档位表随型号变，由 Codex 运行时自己收敛）。
7. 分析请求对三家 CLI 都是只读：Codex 只读沙箱；Claude 自动拒绝写文件 / 执行命令（即使用户
   `~/.claude/settings.json` 的 allow 里放行了 Bash / Write / Edit）；Gemini 不开 yolo。
   冲突会话需要改文件，不受此限制。
8. Codex 专属字段（personality、serviceTier）只发给 Codex。
9. Claude / Gemini 回答在 JSON 前有带 `{` 的旁白时，分析结果仍能解析出策略。
10. 设置项旁显示识别结果标签（如「Claude CLI」），与真实路由同一判据，随输入实时变化。
11. 说明文案写明格式与自动选择规则，并修正过时的默认模型描述。

## 不做

- 不给 Claude 分析请求开 plan 模式（plan 会弹 ExitPlanMode 审批卡，Git 卡拿不到回答正文）。
- 不新增独立的「Git 卡 CLI」下拉；归属完全由模型名决定。
