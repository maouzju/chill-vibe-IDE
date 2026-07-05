# 设计

## 关键约束

- Electron ≥32 移除了 `File.path`，渲染进程拿本地路径必须经 preload 的 `webUtils.getPathForFile(file)`（同步，contextBridge 可直接透传 File 对象）。
- Composer textarea 是 ref 驱动的非受控输入（`defaultValue` + `draftValueRef`），程序化改值必须同时写 `textarea.value` 并调 `syncLocalDraft(next)`，否则草稿持久化与 slash 检测会脱节。

## 变更点

| 文件 | 变更 |
|------|------|
| `electron/preload.ts` | `electronAPI.getPathForFile: (file: File) => webUtils.getPathForFile(file)` |
| `src/electron.d.ts` | 补 `getPathForFile?: (file: File) => string` 类型 |
| `src/components/composer-paste.ts`（新） | 纯函数：`collectPastedFilePaths`（取路径、吞异常、滤空串）、`formatPastedFilePathInsertion`（引号+空格连接）、`insertTextAtSelection`（选区替换+边界补空格+光标位置） |
| `src/components/ChatCard.tsx` | `handlePaste` 增加非图片文件分支：拿到 ≥1 条路径才 `preventDefault`，替换选区插入，`syncLocalDraft` 同步 |
| `tests/composer-paste.test.ts`（新） | 纯函数单测，注册进 `tests/index.test.ts` |

## 行为矩阵

| 剪贴板内容 | 行为 |
|-----------|------|
| 资源管理器复制的非图片文件 | 插入路径文本 |
| 资源管理器复制的图片文件 | 图片附件（现状） |
| 图片 + 非图片混合 | 图片进附件，其余插路径 |
| 截图位图（无路径） | 图片附件（现状） |
| 纯文本 | 默认粘贴（现状） |
| web 模式的文件 | 不拦截（现状） |

## 测试策略

Tier 1 red→green：路径收集/格式化/插入逻辑全部在纯 helper 中，用 Node `--test` 单测钉死；ChatCard 接线为薄胶水（事件对象→helper→syncLocalDraft），随 `pnpm test:quality` 验证类型与 lint。
