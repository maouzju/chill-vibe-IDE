# 古法 Git 暂存切换响应设计

## 取证分层

把一次复选框操作拆成两个独立指标：

1. **反馈时间**：浏览器实际收到 click 事件，到受控 checkbox 在一次 `requestAnimationFrame` 后呈现目标值。
2. **收敛时间**：后台 Git 暂存请求完成，checkbox 解除 pending，并由权威状态确认目标值。

性能门禁只用第一项判断 UI 是否卡住；第二项用于诊断 Git/磁盘延迟和并发正确性，不混为一个数字。

## Electron 测试方式

- 点击前在目标 checkbox 上安装一次性 capture click 监听器。
- 监听器用 `performance.now()` 记起点，并逐帧检查 checkbox 的 `checked` 值。
- Playwright 仍执行真实 locator click，但宿主侧等待不计入 renderer 指标。
- 每个测试数据目录同时作为独立 `CHILL_VIBE_RUNTIME_PROFILE_ROOT`，隔离 Chromium 配置。
- 三个切换发出后等待对应 checkbox 全部解除 disabled，再断言最终都为 checked。

## 状态收敛

先用上述红测确认当前实现是否存在真实渲染延迟或响应乱序：

- 如果 renderer 反馈已达标而宿主墙钟超标，只修正错误门禁，不做猜测式生产优化。
- 如果最终状态会被乱序响应覆盖，则在 `GitFullDialog` 内引入小型、可撤销的暂存队列：即时记录每个路径的期望状态，后台按批次串行执行，并在应用权威状态时继续覆盖尚未收敛的 optimistic 值。
- 如果单次服务端暂存仍显著拖慢收敛，再单独减少 `setGitWorkspaceStage()` 的重复仓库扫描；该优化必须有 Git 进程数或收敛时间红测，不与 UI 门禁捆绑猜测。

## 安全边界

- optimistic 状态只影响显示；Git 返回错误时清理相应路径并刷新权威状态。
- 右侧 patch 继续通过 `mergeGitStatusPreservingPreviews()` 保留。
- 不新增持久化字段或共享 schema。

## 取证结论（2026-07-20）

修正门禁后，在同一次 `pnpm test:perf:electron` 组合运行中测得三次 renderer click-to-paint
分别为 **5.2ms、4.2ms、4.1ms**，并且三个后台暂存请求完成后都保持勾选，右侧 diff 未改变。

因此旧的 7.7s / 2.2s / 4.0s 数字不是产品渲染延迟，而是 Playwright 宿主墙钟混入了
跨进程调度和测试机负载。本切片只修正性能门禁和 Electron profile 隔离；没有证据支持修改
`GitFullDialog` 调度、增加暂存队列或继续减少服务端扫描。
