# 全完成提示音任务

- [x] 明确“全完成”边界与两个提示并行独立的验收规则。
- [x] 先添加设置归一化、资源路径和全完成判定红测。
- [x] 增加设置字段、中文/英文文案与两处设置 UI。
- [x] 生成三音 WAV，并实现独立的稳定检查与播放路径。
- [x] 运行定向测试、质量检查、主题/设置界面验证。
- [x] 构建 Electron，重启当前开发运行时并记录产物。
- [x] 为全完成提示音增加独立持久化音量字段，并先补归一化红测。
- [x] 在两处设置入口增加独立音量滑杆、百分比和三音试听。
- [x] 更新设置界面回归覆盖，完成定向测试、质量检查、构建与运行时重启。

## 验证记录

- 定向 Node 测试：60/60 通过。
- 质量检查：`pnpm test:quality` 通过。
- 设置界面 Playwright：6/6 通过，暗色与亮色主题均覆盖。
- Electron 产物：`dist/release-20260726-172445/Chill Vibe-0.18.18-win.zip`，并生成同目录 `win-unpacked/Chill Vibe.exe`。
- 全量 `pnpm test:theme` 未作为本功能阻断项：137 项大套件在既有主题快照/后端代理噪声中超时；本功能对应的设置专测已通过。
- 独立音量红测：先确认 `allAgentsDoneSoundVolume` 缺失导致 2 项失败，再实现默认值、归一化与持久化字段。
- 更新后定向 Node 测试：61/61 通过；设置界面 Playwright：6/6 通过。
- 更新后全量主题检查：159/159 通过；`pnpm test:quality` 通过。
- 更新后 Electron 产物：`dist/release-20260726-192359/Chill Vibe-0.18.18-win.zip`，可直接运行 `dist/release-20260726-192359/win-unpacked/Chill Vibe.exe`。
- 当前 Electron 开发运行时已重启，5173 健康检查返回 200，renderer 进程已就绪。
