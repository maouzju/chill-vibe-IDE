# 飞书表格粘贴 — 设计

## 方案

继续使用 `ChatCard` 当前的 `textarea` 和图片附件上传链路，只补齐剪贴板解析层：

1. 在 `src/components/composer-paste.ts` 增加纯函数 `getPastedClipboardText(plainText, html)`。
   - `text/plain` 非空时直接使用，避免改写飞书已经整理好的制表符/换行。
   - `text/plain` 为空时，对 HTML 做安全的轻量转换：删除脚本和样式，`td/th` 之间用制表符，`tr` 和块级元素用换行，最后去除标签并解码常见实体。
2. 在 `src/components/composer-image-paste.ts` 扩展图片地址提取，兼容飞书常见的 `src`、`data-src`、`data-original` 和 `data-image-src`，仍只允许 `data:image/*` 和 `http(s)`。
3. `ChatCard.handlePaste` 的两个富文本分支都先插入 `getPastedClipboardText` 的结果，再处理附件：
   - 内部 Chill Vibe 图片元数据：复用原附件，不重复上传；
   - 外部 HTML 图片：异步下载后进入现有上传/预览流程。
4. 对 HTML 图片分支同时保留原生文件条目处理，避免同一次粘贴里混合图片/文件时漏项。

## 边界与取舍

- 不把 HTML 富文本直接写进消息，也不引入 `contenteditable`；聊天请求目前以纯文本 + 图片附件传输，表格用 TSV 最稳定。
- 不把图片 base64 写进提示词；图片沿用现有附件 API 和持久化机制，避免草稿和 IPC 被大块二进制拖慢。
- 外部图片受 CORS、登录态或链接过期影响时，文字仍正常粘贴；能成功读取的图片继续上传。
- HTML 解析不使用 `innerHTML` 执行路径，只做受限字符串转换。

## 验证

- 先运行 `tests/composer-paste.test.ts` 的新增失败用例，再实现。
- 运行目标 Node 测试和 `pnpm test:quality`。
- 按仓库要求运行 `pnpm electron:build` 并重启当前 Electron 开发运行时。
