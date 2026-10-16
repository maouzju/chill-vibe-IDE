import type { AppLanguage, ChatCard, StreamAgentEntry } from '../../shared/schema'

// 症状（2026-10-16 用户截图）：Workflow「已完成 1/6 · 在跑 2 · 失败 3」，在跑的两个几十分钟零输出，
//   父 agent 回合早已结束，要等整个 Workflow 收尾才收到通知，一直干等、最后拿残缺结果去合成。
// 根因：后台 Workflow 跑着时没有任何东西叫醒父回合；系统提示里的自查闹钟（pitfall #400）只是叮嘱，agent 可能忘。
// 做法：渲染端在 agent 状态推送里看到某个 Workflow 刚刚越过"失败过半"这条线时，给父卡发一次提醒。
//   只认"上一次还没过线、这一次过线"的沿：重启/重新附着后第一次看到就已过半的是旧事，不叫。
export type WorkflowCounts = NonNullable<StreamAgentEntry['workflowCounts']>

export type WorkflowFailureHit = {
  threadId: string
  label: string
  counts: WorkflowCounts
}

const isFailureMajority = (counts: WorkflowCounts | undefined) =>
  !!counts && counts.failed >= 2 && counts.failed * 2 >= counts.total

const readRunningWorkflows = (card: ChatCard) => {
  const runs = new Map<string, StreamAgentEntry>()
  for (const message of card.messages) {
    if (message.meta?.provider !== 'claude' || message.meta.kind !== 'agents' || !message.meta.structuredData) continue
    try {
      const data = JSON.parse(message.meta.structuredData) as { agents?: StreamAgentEntry[] }
      for (const agent of data.agents ?? []) {
        if (agent?.status === 'running' && agent.workflowCounts) runs.set(agent.threadId, agent)
      }
    } catch {
      // 坏快照不影响聊天，跳过即可。
    }
  }
  return runs
}

export const detectWorkflowFailureMajority = (previous: ChatCard, next: ChatCard): WorkflowFailureHit[] => {
  const before = readRunningWorkflows(previous)
  const hits: WorkflowFailureHit[] = []
  for (const [threadId, agent] of readRunningWorkflows(next)) {
    const prior = before.get(threadId)
    if (!prior || isFailureMajority(prior.workflowCounts) || !isFailureMajority(agent.workflowCounts)) continue
    hits.push({ threadId, label: agent.nickname ?? agent.role ?? threadId, counts: agent.workflowCounts! })
  }
  return hits
}

export const buildWorkflowFailureWakePrompt = (hit: WorkflowFailureHit, language: AppLanguage) => {
  const { done, running, failed, total } = hit.counts
  return language === 'en'
    ? `[Chill Vibe auto notice] Background Workflow "${hit.label}" now has ${failed}/${total} failed (${done} done, ${running} running). Check its progress now. If most branches failed or the running agents have produced nothing for a long time (429 / overloaded / timeouts), stop it with TaskStop and tell the user what failed instead of waiting for a degraded result; if it is still worth continuing, say so briefly and end the turn.`
    : `[Chill Vibe 自动提醒] 后台 Workflow「${hit.label}」已失败 ${failed}/${total}（已完成 ${done}，在跑 ${running}）。请现在检查它的进度：如果大部分分支已失败，或在跑的子 agent 长时间零输出（429 / 过载 / 超时），就用 TaskStop 停掉并告诉用户哪里失败了，不要干等残缺结果；如果仍值得继续，简短说明后结束本轮。`
}
