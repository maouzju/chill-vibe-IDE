# 实施任务 — 打开项目外文件

## T1 — 红先测试（`tests/file-system.test.ts`）

- [x] `ensureWithinWorkspace` 在 `{ allowOutsideWorkspace: true }` 下放行项目外绝对路径
- [x] 同一开关下相对路径逃逸（`../../etc/passwd`）仍拒绝
- [x] `readWorkspaceFile` 在 opt-in 下真的读出项目外文件内容
- [x] `writeWorkspaceFile` 在 opt-in 下真的写入项目外文件
- [x] opt-in 下工作区内 symlink/junction 逃逸仍拒绝
- [x] 不带 options 时全部维持现状（现有断言不改）
- [x] 确认先红

## T2 — 实现

- [x] `server/file-system.ts`：`WorkspacePathGuardOptions`，`ensureWithinWorkspace` /
      `ensureWithinWorkspaceCanonical` 透传；`readWorkspaceFile` / `writeWorkspaceFile` /
      `copyWorkspaceFileToClipboard` 接受 options
- [x] `server/file-watcher.ts`：订阅时透传
- [x] `electron/backend.ts`：`readFile` / `writeFile` / `copyFileToClipboard` / `watchFile` 传 opt-in
- [x] 决策注释（症状 / 根因带日期 / 被否决方案）落在 `ensureWithinWorkspace` 上方

## T3 — 说人话的失败提示

- [x] `src/components/text-editor-load-failure.ts` 识别 traversal 错误
- [x] `tool-card-text.ts` 补中英文案
- [x] 单测

## T4 — 相邻能力核对

- [x] Git gutter diff 对项目外文件不阻断编辑器
- [x] tab 标题 / 编辑器缓存 key / 行号 registry 对绝对路径无串扰

## T5 — 验证与交付

- [x] 窄测试全绿
- [x] `pnpm test:quality`
- [x] `pnpm electron:build`（AGENTS.md 强制：确认修复后自动打包）
- [x] AGENTS.md 追加 pitfall
