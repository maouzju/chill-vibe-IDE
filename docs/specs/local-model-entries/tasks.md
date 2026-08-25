# 自定义本地模型条目 — 任务

1. [x] SPEC（requirements / design / tasks）
2. [x] 红：`tests/local-model-entries.test.ts`（归一化 / 令牌往返 / 选项构建）+ 扩 `tests/provider-routing-runtime.test.ts`（按 entry 注入端点、不传 entry 行为不变），确认全红
3. [x] 绿-数据层：`shared/schema.ts` 的 `localModelEntrySchema` + settings 字段 + `shared/default-state.ts` 归一化
4. [x] 绿-令牌层：`shared/models.ts` 的令牌构建/解析 + `buildLocalModelOptions`
5. [x] 绿-后端：`server/providers.ts` 的 `resolveProviderRuntime(provider, { localModelId })` + `launchProviderRun` 上游翻译令牌
6. [x] 接线：`ChatCard.tsx` 选项注入 + 自定义选项排除令牌；prop 经 `App.tsx → LayoutRenderer → WorkspaceColumn → ChatCard` 四层透传；`App.tsx` 路由面板「本地模型」管理区；`state.ts` 增删条目 action + 逐条目清 session + 全局偏好排除令牌；`persistence-queue.ts` 白名单；`app-panel-text.ts` 中英文案
7. [x] 验证：新增窄单测绿（139/139）+ 三个 tsconfig 类型全过 + eslint 干净 + 全量单测 2692/2693（唯一失败 `history-audit` 属并发改动，与本功能无关）+ 真实链路验证路由注入正确

## 实测结论（2026-08-23）

路由层端到端验证通过：令牌被翻成真实模型名、端点/密钥跟着条目走、故意放置的云端 profile 未泄漏。

**但 CLI 侧对 Ollama 均不通**（详见 design.md 的实测表）：Codex CLI 只认 Responses API（404），
Claude CLI 起得来却始终不发请求（原因未查清）。功能本身完整，可用性取决于本地推理服务
提供哪套协议。

## 后续

- [ ] 排查 Claude CLI 指向本地 Anthropic 兼容端点时不发请求的原因（当前唯一阻塞真实可用的问题）
- [ ] 用实现了 Responses API 的本地服务（较新 vLLM 等）验证 Codex harness

## 已知不覆盖

- `AutomationBoardCard` 的模型选择器不并入本地条目。
- 不做 baseUrl 可达性/模型存在性校验（与既有「自定义模型名不校验」策略一致）。
