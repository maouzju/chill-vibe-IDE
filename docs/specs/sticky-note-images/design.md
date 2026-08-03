# 便签图片附件 — 设计

## 总体方案

复用现有 `server/attachments.ts` 原图存储与 `ImageAttachment` 元数据，不创建缩略图文件，也不把 base64 塞进应用状态或 Markdown 正文。便签正文继续保存为人可读 `.md`；图片引用作为轻量元数据保存在 `workspace.json`，历史检查点 JSON 同时记录图片列表。

便签 UI 保留稳定的纯文本编辑器，在编辑器上方增加图片附件带。这样不会把现有 IME、滚动位置、历史和本地 Markdown 工作流替换成高风险富文本编辑器，同时满足“便签内缩略图 + 放大 + 无损交给 Agent”的核心场景。

## 数据与持久化

`shared/schema.ts`：

- `stickyNoteSaveRequestSchema` 新增 `attachments: ImageAttachment[]`，默认空数组并限制合理数量。
- `stickyNoteDocumentSchema` 新增 `attachments`，默认空数组以兼容旧服务端响应和测试夹具。
- `stickyNoteVersionDocumentSchema` 新增 `attachments`，默认空数组以兼容旧历史文件。

`server/sticky-note-store.ts`：

- `StickyNoteIndexEntry` 保存当前 `attachments`；读取旧 `workspace.json` 时补 `[]`。
- 当前 Markdown 文件仍只写正文，便于用户直接阅读和编辑。
- 检查点去重比较 `title + content + attachments`；只改变图片列表也会形成历史版本。
- 历史文件保存附件元数据；恢复时先检查点化当前正文和附件，再一起恢复目标版本。
- 列表与搜索响应继续保持轻量，不返回图片数组；只有加载具体便签或版本时返回。

附件元数据只引用全局附件目录中的原文件。移除便签引用不删除原文件，避免破坏聊天消息、草稿或其他便签中的同一附件。

## 渲染器流程

`StickyNoteCard` 增加本地 `attachments` 状态和 ref，与正文一起参与自动保存：

1. 加载/切换便签时从 `StickyNoteDocument.attachments` 恢复。
2. 工具栏隐藏文件输入支持 PNG/JPEG/WebP/GIF；正文 `paste` 事件读取图片文件。
3. 图片通过现有 `uploadImageAttachment()` 上传，得到的 `ImageAttachment` 追加到当前便签并立即保存；上传期间显示轻量状态。
4. 缩略图使用 `getImageAttachmentUrl(id)` 读取原文件，CSS 仅做 `object-fit` 和尺寸约束。
5. 点击缩略图复用现有结构化预览层与焦点管理打开大图。
6. 移除只更新当前列表并保存；检查点定时器照常记录。

## 无损剪贴板协议

新增共享纯函数模块 `shared/image-attachment-clipboard.ts`：

- 把 `ImageAttachment` 元数据编码进标准 `text/html` 的 `data-chill-vibe-image-attachment` 属性。
- 严格解析、Zod 校验并按附件 ID 去重；无效或外部 HTML 返回空列表。
- 复制按钮会读取原附件为 data URL 后写入 `text/html`，不进行图片解码或重编码；同时写入文件名 `text/plain` 作为外部应用回退。
- 缩略图的原生 `copy` 事件也写入相同 HTML 元数据，因此聚焦后 Ctrl/Cmd+C 可用。

`ChatCard.handlePaste` 在普通图片文件分支之前读取该元数据：

1. 命中内部附件时 `preventDefault()`。
2. 直接创建 `kind: 'uploaded'` 的 composer 附件，预览 URL 指向原附件 ID。
3. 与现有 composer 附件按 ID 去重，并立即镜像到 `card.draftAttachments`。
4. 不调用 `uploadImageAttachment()`，因此没有 fetch → canvas → PNG 或其他转码路径；发送时仍由后端通过原 ID 解析同一文件。

普通外部图片剪贴板仍走现有 `File -> uploadImageAttachment` 分支，不改变行为。

## UI

- 工具栏新增低干扰“插入图片”按钮；窄卡片允许工具栏换行。
- 图片带横向滚动，缩略图固定在约 96×72 px 范围；按钮只在 hover、focus-within 或触屏可见状态出现。
- 每图提供复制与移除，缩略图本体负责放大。
- 放大预览沿用 `.structured-preview-layer`，新增便签专属类用于尺寸与主题覆盖。
- 使用 `src/index.css` 现有主题 token，不引入硬编码亮色背景。

## 测试

- 红先行：`tests/sticky-note-store.test.ts` 覆盖保存/加载附件、仅附件变化生成检查点、恢复前快照与旧索引兼容。
- 红先行：新增 `tests/image-attachment-clipboard.test.ts` 覆盖 HTML 往返、恶意/损坏输入、去重。
- 组件窄测试：便签静态控件包含插图入口且无删除便签动作；Chat composer 内部附件粘贴辅助逻辑复用纯函数验证。
- UI：扩展 `tests/theme-check.spec.ts`，在明暗主题与窄视口检查缩略图带和放大预览；快照只针对新增表面更新。
- 最终运行目标 Node 测试、`pnpm test:quality`、相关主题验证、Electron 构建与当前开发运行时重启。

## 决策说明

不采用 `contenteditable` 富文本或把图片 base64 写入 Markdown：前者会高风险破坏中文输入、撤销和滚动恢复，后者会轻易突破 64 KB 便签限制并导致每次状态保存复制大块二进制。图片附件带保留现有稳定文本编辑器，同时原图只存一份。
