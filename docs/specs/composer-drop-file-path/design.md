# 设计

## 数据流

`drop` 事件 → `event.dataTransfer.files` → `partitionDroppedFiles(files)` 按 MIME 拆成 `imageFiles` / `pathCandidateFiles` → 复用粘贴入口同一段落地逻辑（`ingestExternalFiles`）：图片进 `pendingAttachments` 并后台上传；其余经 preload `getPathForFile` 解析成路径，`formatPastedFilePathInsertion` + `insertTextAtSelection` 写入 textarea，再 `syncLocalDraft`。

## 事件挂点

- `dragover` / `dragenter` / `dragleave` / `drop` 挂在 `.composer-input-row` 上而不是只挂 textarea：textarea 只有一行高，落点太小；同行按钮区也算落区。
- `dragover` 里只有 `dataTransfer.types` 含 `Files` 才 `preventDefault`（否则 pane tab 拖拽的 payload 会被这里吞掉）。**拖拽进行中禁止读 `dataTransfer.files`**（pitfall 196 同族），只读 `types`。
- `drop` 里 `preventDefault` + `stopPropagation`，避免冒泡到 PaneView / App 的 document `drop` 收尾逻辑之外再触发默认导航。
- 视觉：`.composer-input-row.is-file-drop-target` 复用 `--accent` / `--accent-soft` 令牌，两主题共用。

## 全局导航守卫

Electron 主进程没有 `will-navigate` 守卫；Chromium 对未被处理的文件 drop 默认导航到 `file://`。在 `App.tsx` 现有的 document 级 drag 收尾 effect 里加 `dragover` + `drop` 监听：`types` 含 `Files` 时 `preventDefault`。composer 自己的 handler 先于它执行并 `stopPropagation`，互不影响；React 合成事件在 root 容器派发，document 监听不会截住它。

## 纯函数

`partitionDroppedFiles(files: Iterable<File>, supported = supportedImageMimeTypes)` 放在 `src/components/composer-paste.ts`，单测钉在 `tests/composer-paste.test.ts`。
