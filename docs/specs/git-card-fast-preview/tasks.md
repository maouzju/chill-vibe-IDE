# Git 卡牌快显加载任务

- [x] 明确需求与设计。
- [x] 写失败测试：完整 Git 状态延迟时，preview 到达后按钮和改动数已出现。
- [x] 写/更新后端测试：preview 状态不包含 patch/增删行详情。
- [x] 扩展 shared 类型引用、api、Electron preload/main/backend、Express endpoint、测试 mock bridge。
- [x] 调整 GitToolCard 刷新流程：preview 先渲染，full 后补齐。
- [x] 确保分析按钮在 preview-only 状态下先补齐完整状态再启动 Agent。
- [x] 跑窄测试、质量检查，并重启当前开发运行时。

## 2026-07-20 完整预览进程放大补强

- [x] 红测：6 个已跟踪文件的完整预览不得启动超过 6 个 Git 进程。
- [x] 批量读取 HEAD 文件大小并批量生成已跟踪文件 patch。
- [x] 保留 untracked、rename、delete、预算省略和异常回退语义。
- [x] 复跑 Git workspace 窄测、`pnpm test:quality` 和 `pnpm electron:build`。
- [x] 复核古法 Git 复选框响应性能：专项门禁改用 renderer click-to-paint 后测得
  5.2ms / 4.2ms / 4.1ms，确认旧的秒级数字来自 Playwright 宿主墙钟；详见
  `docs/specs/git-stage-toggle-responsiveness/`。

## 2026-08-03 干净工作区同步入口修复

- [x] 红测：有 upstream 的仓库必须显示同步入口，不受 `clean` 状态影响。
- [x] 干净空态与改动状态复用同一个同步按钮判断和渲染。
- [x] 复跑 Git 窄测、双主题 UI 检查、质量检查、打包与运行时重启。

## 2026-08-10 主线程卡顿与状态保真补强

- [x] 自动刷新改走共享节流/in-flight 闸门；暖卡只抓 preview，移除 hover 触发。
- [x] preview 状态保留已有 patch/行数，并让分析与完整 Git 面板在消费前按 fidelity 补抓全量。
- [x] Git stdout/stderr 按 Buffer 完整解码，覆盖跨 chunk 的 UTF-8 路径与内容。
- [x] 为批量 patch 建立等价索引，保留 rename、add、delete、引号路径和 header 回退语义。
- [x] 新增 `git-patch-block-index.test.ts`（8 项）与 `git-status-refresh-policy.test.ts`（17 项）窄测，均已通过。

## 2026-09-11 远端分支尚不存在时的同步

- [x] 红测：用真实 bare 空远端复现 `[gone]`，并覆盖旧引用、fetch 失败、特殊 push.default、异名 tracking 目标、跨分支历史计数和非快进保护（`tests/git-workspace.test.ts` "missing on the remote" 组，11 项）。
- [x] `parseBranchLine` 解析 `[gone]`；`[gone]` 时 ahead 排除目标远端已知提交；`pullGitWorkspace` 成功 fetch/prune 后再验 ref 决定是否 pull。
- [x] `gitStatusSchema` 新增可选 `upstreamGone`；AGENTS.md 新增 pitfall #368。
- [x] 补充红测并修复：远端删除分支后的旧引用、特殊 push.default、按目标远端扣除已发布提交；覆盖 fetch 失败和异名 tracking 目标。
- [x] 复跑 Git workspace 窄测与质量检查（Git/界面窄测通过；整仓 quality 被并行聊天中断改动的既有类型错误阻塞）。
- [x] Windows zip 打包，交付可直接启动的 exe；核对运行实例，遵守已打开发布版不可擅自重启的规则。
