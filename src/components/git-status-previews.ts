import type { GitChange, GitStatus } from '../../shared/schema'

const hasExplicitPreviewData = (patch?: string, addedLines?: number, removedLines?: number) =>
  typeof patch === 'string' ||
  typeof addedLines === 'number' ||
  typeof removedLines === 'number'

const getOptimisticTrackedStatus = (change: GitChange) => {
  switch (change.kind) {
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'typechange':
      return 'T'
    case 'added':
    case 'untracked':
      return 'A'
    default:
      return 'M'
  }
}

export const applyOptimisticGitStageState = (change: GitChange, staged: boolean): GitChange => {
  if (staged) {
    return {
      ...change,
      staged: true,
      stagedStatus:
        change.stagedStatus !== ' ' && change.stagedStatus !== '?'
          ? change.stagedStatus
          : getOptimisticTrackedStatus(change),
      workingTreeStatus: ' ',
    }
  }

  if (change.kind === 'untracked' || change.stagedStatus === 'A') {
    return {
      ...change,
      staged: false,
      stagedStatus: '?',
      workingTreeStatus: '?',
    }
  }

  return {
    ...change,
    staged: false,
    stagedStatus: ' ',
    workingTreeStatus: getOptimisticTrackedStatus(change),
  }
}

// 症状：2026-08-10 用户报输入文字 / 切 tab / 开新会话卡数秒，关掉 2 个 Git 卡片后瞬间恢复流畅。
// 根因：git 刷新整条管线（status 全扫 + `git ls-tree -r -l -z HEAD` + 可达数 MB 的 diff 累加 +
//   6-15 个 git 子进程，Windows 上每个 30-80ms）跑在 Electron 主进程 JS 主线程上，而主进程正是
//   派发输入事件和调度窗口的进程；它被占住几百 ms 到数秒，渲染进程的输入和 tab 切换就一起冻住。
//   卡片只渲染文件名和计数（全文没有一处引用 change.patch），却次次拉全量 diff，纯属白烧主线程。
// 被否决的替代方案：(1) 只把节流时间从 3s 调大 —— 治不了单次刷新本身几百 ms 起的主线程占用，
//   而且 hover 一划过就触发，调多大都会撞上；(2) 把判定留在组件里用 useRef 直接写 ——
//   本仓库没有可驱动交互的 React 组件测试设施（只有 renderToStaticMarkup），留在组件里就等于没有
//   回归防线，所以按 GitFullDialog.tsx:94 runCommitDiffSelection 的既有模式抽成模块级纯函数。

/** 自动刷新（聚焦、tab 激活）共用的节流窗口。 */
export const gitStatusRefreshThrottleMs = 3000

export type GitStatusRefreshDecision = {
  shouldRefresh: boolean
  reason: 'due' | 'no-workspace' | 'in-flight' | 'throttled'
}

/**
 * 自动刷新的唯一闸门：没有工作区不发、上一发还在主进程里跑不叠发、节流窗口没过不发。
 *
 * in-flight 这一项是必须的：卡片的 `isBusy` 只在 workspacePath 变化时才会变成 loading，
 * 请求真正在途期间它仍然是 false，所以光靠 `isBusy` 等于完全没有去重。
 */
export const shouldRefreshGitStatus = ({
  now,
  lastRefreshAt,
  inFlight,
  hasWorkspace = true,
  throttleMs = gitStatusRefreshThrottleMs,
}: {
  now: number
  lastRefreshAt: number
  inFlight: boolean
  hasWorkspace?: boolean
  throttleMs?: number
}): GitStatusRefreshDecision => {
  if (!hasWorkspace) {
    return { shouldRefresh: false, reason: 'no-workspace' }
  }

  if (inFlight) {
    return { shouldRefresh: false, reason: 'in-flight' }
  }

  if (lastRefreshAt > 0 && now - lastRefreshAt < throttleMs) {
    return { shouldRefresh: false, reason: 'throttled' }
  }

  return { shouldRefresh: true, reason: 'due' }
}

export type GitStatusRefreshTrigger =
  /** 聚焦、tab 激活等背景自动刷新 —— 用户没有在要 diff。 */
  | 'auto'
  /** 用户点了刷新按钮、或刚创建仓库这类明确动作。 */
  | 'manual'
  /** 全屏对话框 / 分析变更这类真正吃 patch 的消费方。 */
  | 'consumer'

export type GitStatusRefreshPlan = {
  preview: boolean
  full: boolean
}

/**
 * 决定这一次刷新要不要付全量 diff 的代价。
 *
 * 关键点是 `hasStatusForWorkspace` 的用法必须反过来：git 卡片常驻不卸载
 * （layout-memoization.ts:138 让它即使非激活也保持完整运行时），所以卡片一旦冷启动过一次，
 * 这个标记就永远为真。旧实现拿它去跳过 preview 直奔全量，等于把便宜路径彻底废掉。
 */
export const resolveGitStatusRefreshPlan = ({
  trigger,
  hasStatusForWorkspace,
}: {
  trigger: GitStatusRefreshTrigger
  hasStatusForWorkspace: boolean
}): GitStatusRefreshPlan => {
  if (trigger === 'consumer') {
    return { preview: false, full: true }
  }

  if (trigger === 'manual') {
    return { preview: !hasStatusForWorkspace, full: true }
  }

  return { preview: true, full: !hasStatusForWorkspace }
}

export type GitStatusFidelity = 'preview' | 'full'

/**
 * 判断一份 status 里是否带着服务端刚算出来的 diff。
 *
 * 全量抓取给每个 change 都写了 `patch` 字段（超预算的大文件写空字符串），
 * 轻量抓取（`includeChangePreviews:false`）则整个字段都不存在 —— 两者用类型就能分开。
 */
export const resolveGitStatusFidelity = (status: GitStatus | null): GitStatusFidelity => {
  if (!status) {
    return 'preview'
  }

  if (!status.isRepository) {
    return 'full'
  }

  return status.changes.every((change) => typeof change.patch === 'string') ? 'full' : 'preview'
}

/**
 * patch 消费方（全屏对话框、分析变更）开工前的兜底判断。
 *
 * 两条独立的失效路径都要盖住：
 * 1. 自动刷新后 `trackedFidelity` 是 preview —— 此时 patch 是 merge 回来的上一轮旧内容，
 *    看起来"完整"其实过期，不能拿去喂 AI；
 * 2. 后台 stage/commit 操作回写的 status 本身就没有 patch（走的轻量抓取），
 *    调用方却以为自己拿到的是最新全量。
 */
export const needsFullGitStatusFetch = ({
  status,
  workspacePath,
  trackedFidelity,
}: {
  status: GitStatus | null
  workspacePath: string
  trackedFidelity: GitStatusFidelity
}): boolean => {
  if (!status || status.workspacePath !== workspacePath) {
    return true
  }

  if (!status.isRepository) {
    return false
  }

  return trackedFidelity === 'preview' || resolveGitStatusFidelity(status) === 'preview'
}

export const mergeGitStatusPreservingPreviews = (
  previousStatus: GitStatus,
  nextStatus: GitStatus,
): GitStatus => {
  const previousChangesByPath = new Map(
    previousStatus.changes.map((change) => [change.path, change] as const),
  )

  return {
    ...nextStatus,
    changes: nextStatus.changes.map((change) => {
      if (hasExplicitPreviewData(change.patch, change.addedLines, change.removedLines)) {
        return change
      }

      const previousChange = previousChangesByPath.get(change.path)

      if (!previousChange) {
        return change
      }

      return {
        ...change,
        ...(typeof previousChange.patch === 'string' ? { patch: previousChange.patch } : {}),
        ...(typeof previousChange.addedLines === 'number'
          ? { addedLines: previousChange.addedLines }
          : {}),
        ...(typeof previousChange.removedLines === 'number'
          ? { removedLines: previousChange.removedLines }
          : {}),
      }
    }),
  }
}
