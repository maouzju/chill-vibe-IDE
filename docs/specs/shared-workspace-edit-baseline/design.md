# 共享工作区改动基线：设计

## 数据模型

`StreamEditedFile` 增加可选字段 `patchOmittedReason`：

- `file-too-large`：当前文件或 HEAD 基线超过单文件上限；
- `baseline-unavailable`：文件在回合开始前已脏，但其正文未进入详细基线；
- `detail-file-limit`：详细差异文件数超过上限；
- `patch-budget`：本回合差异正文总预算已用完。

省略项仍携带 `path`、`kind`、`originalPath`（若有），`patch` 为空串，行数为 0。
保持 `patch` 为必填字符串，避免破坏历史解析器；省略原因负责区分“空差异”和“差异未生成”。

## 基线共享

在 `server/git-workspace.ts` 内维护有界的内容寻址 LRU：

1. 读取获准进入详细基线的文本后计算 SHA-256；
2. 以“UTF-8 字节数 + SHA-256”为键查找缓存；
3. 命中时把缓存中的字符串放入新快照，多个快照因此引用同一正文；
4. 未命中时插入，按最近使用顺序维护；
5. 总缓存超过 32 MiB 时逐出最旧条目。

缓存只共享内容，不共享“会话开始时间”。每份 `WorkspaceSnapshot` 仍独立记录当时的 Git 状态与
路径到正文的映射，因此并发回合不会互相借错基线。

## 兜底差异

`diffWorkspaceSnapshot()` 不再因详细文件数或正文预算而 `break/continue` 后静默丢路径：

- 先用 provider 已报告的 `touchedPaths` 过滤归属；
- 能安全生成差异时返回正常条目；
- 不能生成时返回带 `patchOmittedReason` 的文件名条目；
- 已省略基线的路径即使在回合后从 `git status` 消失（例如未跟踪文件被删除、脏文件恢复到
  HEAD），只要 provider 明确报告触碰过该路径，仍返回 `baseline-unavailable` 文件名条目；
- 详细文件数只统计真正生成正文的条目，不限制文件名条目；
- 回合开始前已脏但正文缺失的路径只返回 `baseline-unavailable`，不与 HEAD 比较。

## UI

`StructuredEditsCard`：

- 正常条目维持现有行数和差异预览；
- 省略条目在文件名下显示一行安静的说明；
- 不挂载空的 `StructuredPreviewBlock`；
- 使用现有次级文字 token，不增加边框或强调色，保持双主题一致。

“会话改动汇总”继续统计并列出这些文件；行数未知时显示文件名但不伪造增删数字。

## 验证

- Node 定向测试覆盖四种省略原因、文件名保留、相同内容缓存命中与缓存字节上限。
- 现有 Git 工作区测试继续验证正常文本差异。
- `pnpm test:quality` 验证 schema、服务端与 React 类型。
- UI 通过主题回归检查省略提示的深浅主题；如 Playwright 工具链仍受已知 runner 问题阻塞，记录
  文件级失败并人工检查静态结构，不盲目更新快照。
