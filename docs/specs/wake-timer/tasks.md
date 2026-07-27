# 计时唤醒 — 任务

- [x] 阅读 AGENTS、UI 原则、延后发送与自动鞭策相关规格。
- [x] 冻结需求与设计假设。
- [x] 增加并运行纯逻辑/归一化测试（接手当前工作区时生产实现与测试已同时存在，无法无损重放首次红测；改用聚焦测试和真实交互回归证明行为）。
- [x] 增加共享 schema、默认值与旧存档归一化。
- [x] 实现计时器纯逻辑、批次持久化和三种触发调度。
- [x] 接入设置总开关、composer 计时器模块和待唤醒状态操作。
- [x] 补齐 i18n、主题样式、memo props 与相关文档。
- [x] 运行定向测试、quality、双主题和窄屏验证。
- [x] 构建 Windows 应用并重启当前开发运行时。

## 验证记录（2026-07-25）

- `node --import tsx --test tests/wake-timer.test.ts`：12/12 通过。
- `node --import tsx --test --test-name-pattern='wake timer|wakeTimer' tests/state.test.ts tests/state-store.test.ts`：2/2 通过。
- `powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Specs 'tests/chat-interrupt.spec.ts'`：26/26 通过，其中计时批次整批释放、真正完成后唤醒均通过。
- `pnpm test:playwright`：36/36 通过。
- `pnpm test:quality`：通过。
- `pnpm test:theme`：计时器 dark/light、桌面/窄屏用例全部通过；整套 157 项中 12 个既有非计时器快照仍有差异，未盲目更新无关快照。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-014058/Chill Vibe-0.18.17-win.zip` 和可直接运行目录。
- `pnpm dev:restart`：通过；开发 Electron 已连接 `http://localhost:5173`，健康检查返回 200。运行中的旧打包版未被关闭或重启。

## UI 切换兜底修复（2026-07-25）

- 新增“菜单打开后再启用计时器”的双主题窄高视口回归；修复前 dark/light 均稳定复现菜单越过底边，修复后 2/2 通过。
- 设置菜单现在会观察自身、锚点和卡片尺寸，内容展开或模式切换后立即重新定位；可用高度不足时改为菜单内部滚动。
- `pnpm exec playwright test --config playwright.config.ts tests/theme-check.spec.ts --grep 'wake timer'`：4/4 通过，现有计时器快照无意外变化。
- `pnpm test:quality`：通过。
- `pnpm test:theme`：本次计时器用例全部通过；整套 159 项中 11 个既有非计时器快照仍有差异，未盲目更新无关快照。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-144641/Chill Vibe-0.18.17-win.zip` 和可直接运行目录。
- 当前正在运行的 `dist/release-20260725-014058` 打包版承载用户会话，按运行时安全规则未强行关闭或重启。

## 提前唤醒与内部标签修复（2026-07-25）

- [x] 增加失败测试，复现“等待名单为空但同工作区仍有 Agent 正在运行时错误释放”。
- [x] 工作区模式释放前增加实时运行态硬校验，不再只信持久化等待名单。
- [x] 批次合并仅发送用户原文，不再把“待唤醒消息 N / Scheduled message N”写进 Agent 请求。
- [x] 完成聚焦回归、quality、Windows 构建与安全运行时处理。

## 取消后复原消息（2026-07-27）

- [x] 红测证明取消批次会丢失待唤醒文字、附件或覆盖现有草稿。
- [x] 取消时把整批内容按原顺序放回 composer，并保留用户已开始编辑的新草稿。
- [x] 完成聚焦测试、quality、Windows 构建与当前开发运行时重启。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 因缺少取消复原逻辑稳定失败。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts`：13/13 通过。
- `powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Specs 'tests/chat-interrupt.spec.ts'`：28/28 通过，覆盖取消后实时草稿与持久化草稿同时复原。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260727-010022/Chill Vibe-0.18.19-win.zip` 与可直接运行目录。
- `pnpm dev:restart`：通过；开发 Electron 已重启，renderer `http://localhost:5173` 健康检查返回 200。运行中的旧打包版未被关闭或重启。

验证记录：

- 红测：`node --import tsx --test tests/wake-timer.test.ts` 同时复现“运行中 Agent 未阻止释放”和“内部标签被注入请求”两项失败。
- 红测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts` 新增恢复批次场景稳定复现提前释放。
- 绿测：`node --import tsx --test tests/wake-timer.test.ts`：12/12 通过。
- 绿测：`scripts/run-playwright-specs.ps1 -Specs tests/chat-interrupt.spec.ts`：27/27 通过。
- `pnpm test:quality`：通过。
- `pnpm electron:build`：通过，产出 `dist/release-20260725-222913/Chill Vibe-0.18.17-win.zip` 与 `win-unpacked/Chill Vibe.exe`。
- 用户当前运行的是旧的 `dist/release-20260725-014058` 打包版并承载活跃会话，按安全规则未强制关闭；新构建已放入独立时间戳目录，可在用户自行切换后生效。
