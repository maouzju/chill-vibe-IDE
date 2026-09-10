# 自动更新可靠性任务

- [x] 固化 GitHub API 限流回退需求与设计。
- [x] 完整请求链、版本身份与附件边界测试先红后绿；Electron 空 URL 补充用例先红后绿。
- [x] 更新器 74 项测试通过，含真实 PowerShell 替换与回滚及安装闸门；此前 pnpm test:quality 通过。
- [x] 隐藏 Electron 官方网络探针通过：API 模拟 403 后获取 v0.20.18 官方 ZIP。
- [x] pnpm electron:build 通过：dist/release-20260909-101546/Chill Vibe-0.20.18-win.zip，同目录 win-unpacked/Chill Vibe.exe 可直接运行。未发布、未升级版本号。
- [x] 核对当前正式包进程仍存活，不重启用户工作面；本机没有需要重启的开发实例。
- [x] 用户确认入口为设置中的“更新并重启”；修复重复触发安装导致并发解包/重启的竞态，新增安装闸门测试。
