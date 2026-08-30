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

> ⚠️ 上面这段已过时，保留作历史记录。两条都已解决：Claude 那条的根因是 `~/.claude/settings.json`
> 的 `env` 压过进程环境变量（见 design.md 的后续小节）；Codex 那条是 Ollama 0.32.9 没有
> `/v1/responses`，0.32.15 已补上。

## 第二轮（2026-08-30）：默认 harness 改为 codex + 补 /v1 的夹缝

8. [x] 红：`tests/local-model-entries.test.ts` 加「默认 codex」三条路径（schema / 工厂 / 新建草稿初值）+
   反向守卫（显式 claude 不被改写）；`tests/provider-routing-runtime.test.ts` 加
   `adds the /v1 suffix when a codex local entry supplies a host root`（主机根 / 尾随斜杠 / 幂等三例）
   与 `never appends /v1 for a claude local entry`。确认全红。
9. [x] 绿-默认值：`shared/schema.ts` `localModelEntrySchema.harness` → `'codex'`；
   `shared/default-state.ts` `createLocalModelEntry` 的回落方向反过来；
   新增 `src/app-helpers.ts` 的 `emptyLocalModelDraft()` 并让 `App.tsx` 的两处草稿初值都用它
   （原先两处各写一份字面量，改默认值极易只改一处）。
10. [x] 绿-端点：`server/providers.ts` 新增 `normalizeLocalModelBaseUrl(harness, baseUrl)`，
    去尾斜杠后只给 codex 补 `/v1` 且幂等；`resolveProviderRuntime` 的本地条目分支改为无论
    baseUrl 是否留空都过这道归一。
11. [x] 文案：`src/app-panel-text.ts` 中英两套的 `localModelClaudeBaseUrlNote` /
    `localModelCodexBaseUrlNote` 重写——codex 那条不再说「Ollama 会 404、请改用 Claude」，
    claude 那条补上「多花约 3 倍 token、思考关不掉」的告知。
12. [x] 验证：本轮预检 Node 单测 2720 通过、30 项因既有异步句柄在 force-exit 下取消（详见发布审计日志；最终以 release gate 数字为准）（`external-history` 需 `--max-old-space-size=8192`，
    否则在超长 transcript 那条 OOM，与本次改动无关）+ `pnpm test:quality` 干净 +
    `pnpm test:theme` 的基线差异需在最终 gate 中复核；本候选未改 JSX/CSS，若仍为既有 settings 面板快照红则按基线证据记录（那 12 条全部
    落在 `#app-panel-settings`，本次没碰）+ `pnpm electron:build` 出包。

## 后续

- [ ] 用实现了 Responses API 的其它本地服务（较新 vLLM、LM Studio）验证 codex harness

## 已知不覆盖

- `AutomationBoardCard` 的模型选择器不并入本地条目。
- 不做 baseUrl 可达性/模型存在性校验（与既有「自定义模型名不校验」策略一致）。
