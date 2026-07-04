# Git 回退改动（Discard Changes）— Design

## 数据流

复用现有 git 工具链路：

```
GitFullDialog → src/api.ts discardGitChanges()
  → window.electronAPI.discardGitChanges (electron/preload.ts)
  → ipcMain 'desktop:discard-git-changes' (electron/main.ts)
  → desktopBackend.discardGitChanges (electron/backend.ts)
  → discardGitWorkspaceChanges (server/git-workspace.ts)
```

Web/Playwright 路径：`POST /api/git/discard`（server/index.ts），tests/electron-bridge.ts 的 mock bridge 转发到该端点。

## Schema

`shared/schema.ts`：

```ts
export const gitDiscardRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
})
```

响应复用 `gitStatusSchema`（与 `setGitStage` 一致，返回刷新后的完整状态）。

## 后端语义（server/git-workspace.ts `discardGitWorkspaceChanges`）

对请求路径按当前 `git status` 分类：

1. **索引里的新增（`A`，含 rename 的新路径侧）**：`git rm --cached --ignore-unmatch`（pathspec stdin）移出索引。
2. **untracked / 新增文件**：直接 `fs.rm` 删除工作区文件（`git clean` 不支持 `--pathspec-from-file`，且 fs 删除跨平台可控）。
3. **其余 tracked 改动（M/D/T/R 原路径侧）**：`git restore --source=HEAD --staged --worktree --pathspec-from-file=- --pathspec-file-nul`，一次恢复暂存区 + 工作区。无 HEAD（空仓库）时全部改动只能是新增类，走 1/2。
4. **rename（`R`）**：新路径按新增处理（删除 + 移出索引），原路径进入 restore 集合恢复。
5. **conflicted 路径**：直接报错拒绝（UI 也禁用）。

全部 git 调用带 `-c core.quotepath=false`（现有 `runGit`），路径集合走 `runGitWithPathspecs` stdin（pitfall #174）。

结束后返回 `inspectGitWorkspace(workspacePath, { includeChangePreviews: false })`（与 stage 行为一致，由前端 merge 保留预览）。

## 前端 UI（GitFullDialog）

- 选中文件的 diff 面板 header 加「回退改动」按钮（`git-tool-button is-danger`，冲突文件禁用）。
- 变更列表 header 加「全部回退」入口，对当前 `renderedChanges`（去掉 conflicted）批量回退。
- 点击后不直接执行：把按钮切换为内联确认条（notice 区域上方 or 原位替换）：「确认回退 N 个文件？此操作不可撤销」+ 确认/取消两个按钮。确认后调用 API，pending 期间禁用相关控件。
- 成功后 `mergeGitStatusPreservingPreviews` + `propagateStatus` 刷新（与 stage 一致），失败显示 error notice + `refreshStatus()`。
- 危险色使用现有主题 token（`--danger-*` 或与现有错误 notice 相同 token），不硬编码颜色。

## i18n

`GitLocaleText` 新增：`discardChanges`、`discardAll`、`discardConfirmTitle(count)`、`discardConfirmCopy`、`discardConfirm`、`discardCancel`、`discardError`、`discardSuccess(count)`。

## 测试

- **红→绿单测**（tests/git-workspace.test.ts）：tracked 修改回退、staged 修改回退、untracked 删除、staged 新增（A）回退、工作区删除恢复、conflict 拒绝可另行覆盖。
- `pnpm test:quality`。
- UI 主题快照：现有 Playwright 工具链在本机有已知 runner 问题（pitfall #25/#34），按钮复用现有 token 类，必要时手动验证。

## 第二期：多选选择模型 + 右键上下文菜单

### 选择模型（`src/components/git-selection.ts`，纯函数）

状态从 `selectedPath: string | null` 升级为：

```ts
type GitChangeSelection = {
  paths: string[]        // 选中路径，保持可见列表顺序
  anchorPath: string | null  // Shift 范围锚点
}
```

归约函数 `applyGitSelectionClick(selection, orderedPaths, targetPath, { ctrlKey, shiftKey })`：

- 普通单击：`{ paths: [target], anchor: target }`。
- Ctrl+单击：切换 target 的选中态（结果按 orderedPaths 排序去重），anchor 移到 target；切换后为空集时保留空集（anchor 仍为 target）。
- Shift+单击：anchor（不在列表时退化为普通单击）到 target 的闭区间按 orderedPaths 选中，anchor 不变。
- Ctrl+Shift 同按视为 Shift。

辅助函数：
- `pruneGitSelection(selection, orderedPaths)`：状态刷新后剔除已消失路径（anchor 消失则置 null）；diff 面板选中路径为 `paths.length === 1 ? paths[0] : null` 派生，多选时显示占位。
- `resolveGitContextTarget(selection, targetPath)`：右键在选中行 → 原选择；未选中行 → 重置为单选该行（GitHub Desktop 语义）。

### 右键菜单（GitFullDialog 内联实现）

- `onContextMenu`（行级）：preventDefault，按 `resolveGitContextTarget` 更新选择，把菜单锚定在 `clientX/clientY`（fixed 定位，viewport 边缘夹紧）。
- 菜单项：「回退改动 / 回退 N 个文件的改动」（选中中非冲突路径 → `setDiscardTargetPaths`，全冲突则禁用）。
- 关闭：pointerdown 在菜单外、Escape、列表滚动、窗口 resize、执行菜单项后。
- 样式复用弹层 token（`--panel-*` / menu 相关现有变量），`role="menu"` + `role="menuitem"`，两主题验证。

### diff 面板多选态

`selectedPaths.length > 1` 时右侧显示「已选择 N 个文件」占位（复用 `git-tool-diff-empty` 结构）+「回退 N 个文件的改动」危险按钮，走同一确认条。

### i18n（续）

新增：`discardSelected(count)`（菜单/多选面板按钮共用）、`multiSelectTitle(count)`、`multiSelectCopy`。

### 测试（续）

- **红→绿单测**（tests/git-selection.test.ts）：单击重置、Ctrl 切换增/删、Shift 范围（正向/反向/anchor 失效退化）、Ctrl+Shift 视为 Shift、prune 剔除消失路径、右键目标解析（选中行保持/未选中行重置）。
- GitFullDialog 集成层为展示性接线，按 Tier 1 低风险 prove-after：file-scoped lint + 类型检查 + 手动/运行时验证。
