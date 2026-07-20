# Fable 5 功能跟进 — 需求

## 背景

Claude Code v2.1.170（2026-06-09）发布了 Mythos 级模型 **Claude Fable 5**（`claude-fable-5`，能力高于 Opus 4.8，1M 上下文，$10/$50 每百万 token，出口管制已于 2026-06-30 解除、07-01 恢复全球可用）；v2.1.197 起 `sonnet` 官方别名解析到 **Sonnet 5**（`claude-sonnet-5`，原生 1M 窗口）。同期 CLI 将 ultracode 正式化为 `--settings` 可传的会话设置键。Chill Vibe 的模型表、档位逻辑与 ultracode 激活方式需要跟进。

官方行为依据（code.claude.com/docs/en/model-config、settings、fast-mode，2026-07 抓取）：

- Fable 5 档位支持 `low/medium/high/xhigh/max`，默认 `high`；**思考不可关闭**（session toggle / `MAX_THINKING_TOKENS=0` 均无效，模型按档位自行决定思考量）。
- Fable 5 不是任何账户类型的默认模型，需要用户显式选择。
- `ultracode` 是 Claude Code 会话设置而非 `--effort` 值：向模型发送 `xhigh`，并让 Claude 对实质任务编排动态工作流；可通过 `/effort ultracode`、`--settings` 或 Agent SDK control request 设置。
- fast mode 仅 Opus 4.8/4.7 支持，Fable 5 / Sonnet / Haiku 不支持。

## 需求

### R1 模型表更新

- Claude 模型选择器出现 **Fable 5**（`claude-fable-5`）与 **Sonnet 5**（`claude-sonnet-5`）。
- `/model fable`、`/model fable-5` 解析到 `claude-fable-5`；裸 `sonnet` 别名改指 `claude-sonnet-5`（对齐官方别名语义）。
- **Sonnet 4.6 条目保留**，仅保留精确别名（`sonnet-4.6`、`claude-sonnet-4-6`）：它仍是可用模型，显式选择不得被静默迁移（Pitfall #119）。
- `DEFAULT_CLAUDE_MODEL` 维持 `claude-opus-4-8`（官方也不把 Fable 5 设为默认）。
- 新建 Agent 聊天应继承当前 pane 最近使用的聊天模型；即使当前激活的是天气、Git 等工具 tab，也不能回退到列中残留的 Fable 5。

### R2 Fable 5 思考约束

- Fable 5 卡片的请求**永不发送 `--effort none`**：思考被关闭或档位为 `auto` 时，回退发送 Fable 5 的模型默认档位 `high`。
- Fable 5 卡片的档位菜单不出现 `auto` 项；已持久化 `auto` 的旧卡在 Fable 5 上显示并按 `high` 处理。
- Fable 5 卡片的"思考"开关禁用（视觉上保持勾选、不可切换），与官方"思考不可关闭"一致。

### R3 模型级默认档位

- Fable 5 的默认档位为 `high`（官方默认，且 max 在 Fable 上有过度思考与成本风险）。
- 其他 Claude 模型默认档位维持 `max`，Codex 维持 `xhigh`，schema 级默认不变。

### R4 ultracode 走官方通道

- ultracode 档位激活时，`--settings` JSON 携带 `"ultracode": true`，不再向系统提示注入 ultracode 关键词（旧 hack 依赖 `workflowKeywordTriggerEnabled` 默认开启，用户可关掉导致静默失效，且污染系统提示）。
- `--effort` 继续映射为 `xhigh`（与官方 ultracode 行为一致）。
- 旧版 CLI 对未知 settings 键按宽松校验处理（警告不致命）；最坏退化为纯 xhigh，可接受。

## 非目标（本次不做）

- **fast mode**：`/fast` 为交互命令，headless 下的开启方式未实证。
- **fallbackModel 降级链**：可用性增强，另行任务。
- **安全分类器降级的 UI 跟随**（Fable 被 flag 后自动切 Opus 的流事件格式未实证，盲写有过度设计风险）；现有 Pitfall #47 的 sessionModel 校验已防止跨模型误续传。
- `best` 别名（其"有权限用 Fable 否则最新 Opus"语义无法在 IDE 侧解析为固定 id）。
