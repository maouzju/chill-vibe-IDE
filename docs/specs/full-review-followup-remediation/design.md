# Design — Full Review Follow-up Remediation

每个切片独立、可单独回滚，且各自钉在一个已注册的窄测试文件里。

## Slice 1 — Git Agent 策略提交的路径闸门

两道防线，位置刻意分开：

- **结构闸门**（`src/components/git-agent-panel-utils.ts`）：`isCommitStrategy` 收紧到逐条校验 `commits[].summary` 是字符串、`paths` 是字符串数组。`repairTruncatedJson` 补出来的半截对象（`paths` 为 `undefined`）不再能冒充合法策略。这里拿不到 `GitStatus`，所以只做结构校验。
- **范围闸门**（新的纯函数 `scopeStrategyCommitPaths`）：执行期把模型声明的路径与最新 `GitStatus` 的非冲突改动求交，输出使用真实 status 的规范写法。`.` / `*` / `**` / 空串这类通配 token 展开成「本次分析范围内的全部改动」，而不是交给 git 去扫整棵树。

`executeAgentStrategy`（`src/components/git-operation-hub.ts`）改为：每笔提交先求交，交集为空就跳过并计数；`setGitStage` 与 `commitGitChanges` 都只收过滤后的路径；全部提交都被跳过时显式抛错。`commitGitChanges` 现在携带 `paths`，走服务端已有的 `git commit --only --pathspec-from-file=-` 子集提交路径。

不改服务端：不带 `paths` 提交整个 index 是 `commitAllGitWorkspace` 依赖的合法语义。

## Slice 2 — 重命名整体处理

把 `discardGitWorkspaceChanges` 里的 rename 判定抽成共用的 `isRenameOrCopyChange`，并新增 `renamePathspecsForChange` / `expandRenamePathspecs`（无 rename 时返回同一个数组引用，非 rename 选择逐字节不变）。

- **取消暂存**：先用 `{ includeChangePreviews: false, includeRepositoryDetails: false }` 快路径读一次 index，再把 rename 展开成两侧路径，`restore --staged` / `reset HEAD` / `rm --cached` 三条回退都用展开后的列表。
- **按选中文件提交**：最终 pathspec 用 `flatMap` 展开两侧，`git commit --only` 才能把 rename 记成一条 `rename old => new`。冲突与「已取消的暂存新增」过滤（pitfall 67）保持不变。
- **暂存刻意不展开**：这是本切片唯一偏离原始审查描述的地方。已暂存的 rename 里 `old` 在工作区和 index 里都已不存在，`git add old` 会 `fatal: pathspec ... did not match any files` 并中止整批（2026-08-02 实测）；而 `git add new` 本身就已携带完整 rename。`git add` 没有 `--ignore-unmatch`，逐个探测存在性又要为一次必然 no-op 多开一个 Git 进程。这条不对称用守卫测试钉住：stage 一个 `RM` rename 后结果必须仍是完整的 `R` 且 `originalPath` 健在。

大批量路径继续走 `--pathspec-from-file=- --pathspec-file-nul` stdin（pitfall 174）。

## Slice 3 — 标签移动与关闭的原子性

`src/state.ts`：

- `closeTab`：把 `findPaneInLayout` 校验提到归档与 `clearPmLinksForCardId` 之前，校验失败直接返回原 state 引用。
- `moveTab`：在任何删除/写入之前一次性校验两端 pane 都存在（照 `splitMoveTab` 的范式）。
- 同列跨 pane 移动改为单个 `updateColumn` 回调内「先插入目标、再摘除源、最后统一折叠」，目标 pane 此刻已非空，`collapseLayout` 不会再把它删掉（pitfall 21 从源头消除，不需要折叠后回滚）。

## Slice 4 — 跨工作区移动停掉旧进程

新纯函数 `willMoveTabAcrossColumns`（`src/app-helpers.ts`）复算一遍 reducer 的接受条件（两端 pane 存在、卡片在源列、确实跨列）。`App.tsx` 的 `onMoveTab` 在 dispatch 之后按这个判断 `closeStream(tabId, true)`。

判断必须在 dispatch **之前**取当前状态、在 dispatch **之后**执行停止：reducer 拒绝移动时卡片没搬走，绝不能误停用户仍在跑的 Agent。不采用「禁止拖动 streaming 标签」，因为那会重新踩到 pitfall 176 的 draggable 雷区，而跨列移动本来就必须换工作区重开会话。

## Slice 5 — 关闭工作区的顺序

`App.tsx` 的 `removeColumn` 把快照保存提到清队列与停流之前。快照落盘前先经过新纯函数 `settleClosedWorkspaceColumn`：把 `streaming` 卡收尾成 `idle` 并清掉 `streamId`，避免重开的工作区复活一批指向已死进程的假流。

不依赖启动时 `attachStreamsForState` 的 "Stream not found" 自愈（pitfall 185）——那是崩溃后的兜底，正常关闭不该故意产出需要自愈的状态。

## Slice 6 — 白噪音生成的沙箱与进程监管

`server/whitenoise/whitenoise-generator.ts`：

- argv 构建抽成导出的纯函数；codex 分支删掉 `--dangerously-bypass-approvals-and-sandbox`，改 `--ask-for-approval never --sandbox read-only`，与 `buildCodexArgs` 及 Brainstorm / Git Agent 的 `sandboxMode: 'read-only'` 先例一致。
- spawn 照抄 `readCodexManagementPolicy` 的监管模板：`settled` latch + 硬超时（可用 `CHILL_VIBE_WHITENOISE_CLI_TIMEOUT_MS` 覆盖）+ 超时 kill + `spawn` 同步异常 / `error` / `close` 全部走同一个 finish。
- stdout/stderr 改为有界累加 + 逐行摘取，答案在流过来的当下就取出，所以封顶截断后仍能拿到场景 JSON。Claude 分支同受保护。

## Slice 7 — 停止与工作区差异的顺序

`server/chat-manager.ts`：

- `finalizeWithWorkspaceEdits` 在 `await` 返回**之后**重新检查 `terminal` 才发 edits（入口那次检查早已过期）。守卫只看 `terminal` 不看 `stopRequested`，因为被停止推迟的流此时仍非终态，正是要让它的 edits 先发出去。
- `stop()` 发现有 diff 在飞时，把终态 `done` 交给那次 in-flight settle 顺序发出，并挂一个 3 秒硬上限的兜底定时器。子进程仍然同步立即被 kill，只有终态信封被推迟；git 卡死时 3 秒后照样发 done，退化成「丢 edits」这个可接受的兜底。
- `emit()` 增加终态守卫（`finalize` 自己那次显式放行），顺带堵住被 kill 的子进程最后一段 stdout flush 出来的 delta/activity 追加到 `done` 之后。

被否决：await 后直接丢弃 edits（用户就无从得知文件被改了）；`stop()` 里 await 那次 diff（违反停止必须立即生效）。

## Slice 8 — sidecar 索引失败后可重试

`server/session-history-catalog.ts` 给 manifest 新增平行字段 `skippedFileStamps`（`{name,size,mtimeMs}`），戳来自解析切片里**已经发生**的那次 `stat`，零额外 syscall。`shouldRun` 只有在原有三个条件全不成立时，才对这份小集合（封顶 64 条）重新 stat；戳变了就把文件从 `knownFileNames` 放行重解析。

`fingerprintNames` / `listSidecarNames` 一个字节没动：健康目录零额外 IO。不把 `skippedFileNames` 改成对象数组，因为旧版本读到新 catalog 会 parse 失败并对全部 sidecar 做一次全量重建。

## Slice 9 — 历史提交 diff 的预算与代次

- 服务端 `fetchCommitDiff` 加 512 KiB 默认预算（`GitCommitDiffLimits` 可注入小额上限供测试使用，pitfall 198），超限时在行边界截断并追加可见的 `[Chill Vibe] Diff truncated after X of Y…` 提示，用户能看出是截断而不是 diff 本身就这么短。签名仍是 `Promise<string>`，`electron/backend.ts` 与 `server/index.ts` 未受影响。
- 已知残留（本轮刻意不扩大范围）：`runGit` 仍会先把完整 stdout 累加成字符串再交给预算裁剪，内存峰值本身还在；`fetchCommitDiff` 的 `assertRepository()` 也仍走带完整预览的 inspect。两项都记在后续优化里。
- 前端 `GitFullDialog` 的 `handleSelectCommit` 加请求代次 ref：迟到的响应不写 state，也不清对方的 loading 标志。不用 `cancelled` 闭包，因为那是「卸载即作废」，解决不了同一次挂载内两个请求乱序。

## Slice 10 — 原生会话完成判定只读尾部

`server/native-turn-completion.ts` 新增 `readNativeSessionTailVerdict`：`fs.promises.open` + 从 `stat().size` 倒着按窗口读，判不出结论就窗口翻倍，直到有结论 / 读到文件开头 / 撞 8 MiB 上限。两个 `classify*` 纯函数签名与语义零改动。

半行安全靠两层：窗口起点不在 0 时无条件丢掉第一行；且 `classify` 倒序返回第一条实质条目，丢掉最靠前那行只可能把结论降级成 `unknown`，而 `unknown` 会触发扩窗重读，绝不会把结论翻成另一个值。回归用逐字节枚举窗口起点的 sweep 测试钉住（夹具里埋了「正文原样引用整条条目」的诱饵行）。

不动 `server/session-fork.ts`：fork 需要从文件头改写到切点并写回完整新文件，与尾读正交。

## Verification strategy

- 全部十项严格红→绿；`GitFullDialog` 的代次守卫用「对修复前源码跑同一断言必为假」做等价红色验证。
- 各项跑自己的窄测试文件，另跑相邻套件确认无连带破坏。
- 合并后跑 `pnpm test:quality`，再 `pnpm electron:build`。
