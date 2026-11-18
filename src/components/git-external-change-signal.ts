// 症状：2026-11-18 用户报「有时候 Git 卡显示的更改其实已经提交了」。
// 根因：Git 卡只在三种时机重读仓库 —— 点到卡片（onFocus）、tab 激活（isActive 翻转）、手动刷新。
//   卡片常驻并排显示时，隔壁会话里的 agent 跑完 `git commit`、或用户在外部终端提交，
//   这三个时机一个都不会触发，卡片就一直挂着提交前的文件列表。
// 被否决的替代方案：(1) 定时轮询 —— 2026-08-10 卡顿事故的教训（见 git-status-previews.ts）是
//   不能让 git 管线无缘无故周期性地跑，空闲时也烧；(2) 只在回合结束时刷 —— 本仓库的 agent 提交后
//   还会接着打包几分钟，回合迟迟不结束，这段时间卡片照样是旧的，所以命令落定也要发信号。
// 这里只发「可能变了」的信号，真正刷不刷、付多大代价仍由 Git 卡自己的节流 + 轻量 preview 决定。

type Listener = () => void

const listenersByWorkspaceKey = new Map<string, Set<Listener>>()

const normalizeWorkspaceKey = (workspacePath: string) =>
  workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const keysOverlap = (left: string, right: string) =>
  left.length > 0 &&
  right.length > 0 &&
  (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))

/** 同一目录，或互为父子目录（会话开在仓库子目录、Git 卡开在仓库根，改的是同一个仓库）。 */
export const gitWorkspacesOverlap = (left: string, right: string) =>
  keysOverlap(normalizeWorkspaceKey(left), normalizeWorkspaceKey(right))

export const subscribeGitWorkspaceChange = (workspacePath: string, listener: Listener) => {
  const key = normalizeWorkspaceKey(workspacePath)

  if (!key) {
    return () => undefined
  }

  const listeners = listenersByWorkspaceKey.get(key) ?? new Set<Listener>()
  listeners.add(listener)
  listenersByWorkspaceKey.set(key, listeners)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByWorkspaceKey.get(key) === listeners) {
      listenersByWorkspaceKey.delete(key)
    }
  }
}

export const notifyGitWorkspaceMayHaveChanged = (workspacePath: string) => {
  const key = normalizeWorkspaceKey(workspacePath)

  if (!key) {
    return
  }

  for (const [listenerKey, listeners] of listenersByWorkspaceKey) {
    if (!keysOverlap(key, listenerKey)) {
      continue
    }

    for (const listener of [...listeners]) {
      listener()
    }
  }
}

/** 命令落定（成功 / 失败 / 被拒）才算「仓库可能变了」；还在跑的命令不发，免得一条命令刷两次。 */
export const shouldSignalGitChangeForActivity = (activity: { kind: string; status?: string }) =>
  activity.kind === 'command' && activity.status !== undefined && activity.status !== 'in_progress'

/** 上一发还在途时，隔多久回来重读。 */
export const gitExternalRefreshInFlightRetryMs = 600

/**
 * 外部信号该等多久再刷：0 = 立刻。
 *
 * 和点击聚焦走的 `shouldRefreshGitStatus` 不同，这里**不能丢信号**：
 * 节流窗口内来的信号要顺延到窗口结束；上一发在途时它读到的可能是提交前的状态，也要回头重读。
 * 丢掉的话，「刚好 3 秒内提交」这一类就又会留下过期列表。
 */
export const resolveExternalGitRefreshDelay = ({
  now,
  lastRefreshAt,
  inFlight,
  throttleMs,
}: {
  now: number
  lastRefreshAt: number
  inFlight: boolean
  throttleMs: number
}): number => {
  const throttleRemaining =
    lastRefreshAt > 0 ? Math.max(0, lastRefreshAt + throttleMs - now) : 0

  if (inFlight) {
    return Math.max(throttleRemaining, gitExternalRefreshInFlightRetryMs)
  }

  return throttleRemaining
}
