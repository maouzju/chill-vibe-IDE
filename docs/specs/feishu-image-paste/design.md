# Design — 飞书文档图片粘贴

1. 在 composer 粘贴处理前读取 `text/html` 与 `text/plain`。
2. 用受限的字符串解析提取 `img[src]`、`img[data-src]`、`img[data-original]` 和 `img[data-image-src]`，过滤非 `data:` / `http(s):` 协议、重复源和超大 HTML；不执行剪贴板 HTML。
3. 对 data URL 直接转 File；对 http(s) 用 fetch 转 Blob，失败则跳过该图片。
4. 只要检测到图片源就阻止浏览器默认粘贴，先插入纯文本/TSV，再异步加入图片附件；失败不影响文字。
5. 已有 `ImageAttachment` 上传及消息发送链路不变；内部 Chill Vibe 图片优先复用原附件 ID，避免二次上传。
