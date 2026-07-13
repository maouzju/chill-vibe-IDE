# 共享工作区改动基线：任务

1. [x] 写明需求、数据模型、共享缓存和超限展示规则。
2. [x] 红：补充定向测试，证明大文件、基线超限和差异预算超限时文件名不会消失。
3. [x] 红：补充内容寻址缓存命中与硬上限测试。
4. [x] 绿：扩展 `StreamEditedFile` schema，并实现有界共享正文缓存。
5. [x] 绿：让 `diffWorkspaceSnapshot()` 返回带省略原因的文件名条目。
6. [x] UI：显示双语省略说明，不渲染空差异预览。
7. [x] 文档：同步 `docs/design.md` 的工作区基线约束。
8. [x] 验证：定向测试、`pnpm test:quality`、主题检查、Electron 打包。
9. [x] 发布审计补漏：已省略基线的路径从 `git status` 消失时，仍按 provider 的 touched path
   保留文件名，并补回归测试。
