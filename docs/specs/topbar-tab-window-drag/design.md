# 顶栏标签按住拖动窗口 — 设计

## 为什么不能用 CSS

`-webkit-app-region: drag` 的元素在 Windows 无边框窗口里由系统接管鼠标，DOM 收不到
`mousedown`/`click`（Electron 官方文档亦如此说明）。标签既要能点又要能拖，就只能
在渲染层用 pointer 事件识别手势，再通过 IPC 请主进程移动窗口。

被否决的替代方案：

- **标签改成 `drag`**：标签点不动，等于把导航砍了。
- **只把标签的 padding 做成 `drag`、文字做 `no-drag`**：同一个按钮一半能拖一半不能，
  用户按在字上仍然拖不动，正是本次截图报的位置。
- **主进程发 `WM_NCLBUTTONDOWN` 借原生拖动（带贴边吸附）**：Electron 没有发送
  Windows 消息的公开 API，需要 native addon，不值得为一个标题栏手势引入。

取舍：手动拖动没有 Aero Snap 贴边吸附；顶栏空白处的原生拖拽仍然有。

## 主进程：`electron/window-pointer-drag.ts`

纯函数 + 适配器，沿用 `window-hit-test-rebuild.ts` 的模式，方便 Node 直接测。

- `decideWindowPointerDragStart({ visible, minimized, fullScreen })` → `'start' | 'skip'`。
- `resolvePointerDragSession({ cursor, bounds, maximized, restoredBounds })`：
  返回 `{ offsetX, offsetY }`。非最大化：`cursor - bounds.origin`。最大化：
  横向按 `cursor.x` 在最大化窗口内的比例映射到还原后的宽度，纵向取
  `cursor.y - bounds.y` 并夹在还原后高度内。
- `resolvePointerDragPosition(session, cursor)` → `{ x, y }`，四舍五入到整数 DIP。
- `createWindowPointerDragController(win, { getCursor, schedule })`：
  `begin()` / `move()` / `end()` 三个动作；`begin` 若窗口最大化先 `unmaximize()`
  再取 `getBounds()` 算还原尺寸；`move` 读 `screen.getCursorScreenPoint()`（主进程
  DIP 坐标，与 `setPosition` 同一坐标系，不信任渲染进程传来的 `screenX`）；
  每次 `move` 重置 3 秒看门狗，超时自动 `end()`。窗口 `blur` 也 `end()`。

IPC（`electron/main.ts` `registerDesktopHandlers`）：

- `window:pointer-drag-begin`（`ipcMain.handle`）→ 返回是否开始；
- `window:pointer-drag-move`（`ipcMain.on`，单向，高频）；
- `window:pointer-drag-end`（`ipcMain.on`）。

为什么 move 用 `ipcMain.on`：pointermove 可达数百 Hz，`invoke` 的往返回执没有人读，
只会在主进程排队。渲染侧再用 `requestAnimationFrame` 把 move 合并成每帧一次。

## 渲染侧：`src/components/topbar-window-drag.ts`

纯状态机 `createTopbarWindowDragController({ thresholdPx, begin, move, end })`：

- `onPointerDown(e)`：仅 `pointerType === 'mouse'` 且 `button === 0` 记录起点；
- `onPointerMove(e)`：距离超过阈值后调 `begin()`（一次），之后每次调 `move()`；
- 拖动期间每 500 ms 调度一次合帧 move，让按住不动也能续期主进程的 3 秒看门狗；
  松手、取消、丢失捕获时取消续期。不能仅靠 pointermove 续期，否则暂停后无法继续拖动。
- `onPointerUp / onPointerCancel / onLostPointerCapture`：若已拖动则 `end()`，并把
  `suppressNextClick` 置真；
- 标签 `onClick`：调用 `consumeSuppressedClick()`；为真时跳过标签切换并清零。

`App.tsx` 顶栏标签按钮挂这组处理器，只在 `usesCustomWindowFrame` 为真时挂。
按下时 `setPointerCapture`，保证窗口开始移动、光标相对窗口位置变化后事件仍投递给
同一个按钮。

桥接：`preload.ts` 暴露 `beginWindowPointerDrag / moveWindowPointerDrag /
endWindowPointerDrag`；`src/api.ts` 包装成三个函数，桥接缺失时静默返回 false /
no-op（浏览器模式不能因为顶栏抛错）。

## 测试

1. `tests/window-pointer-drag.test.ts`：几何纯函数、最大化比例映射、skip 场景、
   控制器 begin/move/end 顺序、看门狗超时自动结束。
2. `tests/topbar-window-drag.test.ts`：阈值内松开不 begin、超阈值 begin 一次 + 多次
   move、up 后 end + 吞一次 click、右键 / 触摸不触发。
3. `tests/renderer-electron-bridge.test.ts`：三个 api 走桥接；桥接缺失时不抛。
4. `tests/electron-runtime.test.ts`：main.ts 注册三条通道，preload 暴露三个方法。
5. `tests/github-shell.spec.ts`：标签仍 `no-drag`（既有）；新增：拖动手势调用桥接
   且活动标签不变、单击仍切换。
6. `tests/electron-topbar-window-drag-runtime.test.ts`（隐藏窗口 Electron 运行时，登记在
   `scripts/run-electron-runtime-tests.ps1`）：真实 BrowserWindow 最大化后经桥接 begin，
   断言 `unmaximize()` 紧接的 `getBounds()` 已是还原尺寸、窗口落在 `screen.getCursorScreenPoint()`
   下（留 80 DIP 鼠标抖动余量）、end 之后的 move 不再移动窗口、最小化窗口拒绝拖动。
   这是设计里"按 Windows 行为推断"的那条同步性假设的实机证据。
   本轮验证使用独立临时 profile/data 目录；测试需真实可见性状态时采用透明、无任务栏、
   `showInactive()` 窗口，避免弹出可见测试界面或污染用户正在使用的打包版。
