import type { AppLanguage, ChatCard, StreamAgentEntry } from '../../shared/schema'

// 症状（2026-10-16 用户截图）：Workflow「已完成 1/6 · 在跑 2 · 失败 3」，在跑的两个几十分钟零输出，
//   父 agent 回合早已结束，要等整个 Workflow 收尾才收到通知，一直干等、最后拿残缺结果去合成。
// 根因：后台 Workflow 跑着时没有任何东西叫醒父回合；系统提示里的自查闹钟（pitfall #400）只是叮嘱，agent 可能忘。
// 做法：渲染端在 agent 状态推送里看到某个 Workflow 刚刚越过叫醒线时，给父卡发一次提醒。
//   只认"上一次还没过线、这一次过线"的沿：重启/重新附着后第一次看到就已过线的是旧事，不叫。
// 2026-10-22 改为触发式（用户截图：「失败 2/3（已完成 0，在跑 1）」就被叫醒）：旧线"failed 过半"不分原因，
//   起步时 total 只算已派出的几个，脚本自己会重试的普通失败也会叫。现在只数灾难性失败
//   （429 / 过载 / 5xx / 超时 / 断网，判定见 server/claude-agent-status.ts isCatastrophicWorkflowError），
//   累计到 2 个才叫：一个可能是偶发抖动，两个基本说明上游在出事。
export type WorkflowCounts = NonNullable<StreamAgentEntry['workflowCounts']>

export type WorkflowFailureHit = {
  threadId: string
  label: string
  counts: WorkflowCounts
}

const catastrophicWakeThreshold = 2

const isCatastrophic = (counts: WorkflowCounts | undefined) =>
  (counts?.catastrophic ?? 0) >= catastrophicWakeThreshold

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

export const detectWorkflowCatastrophicFailure = (previous: ChatCard, next: ChatCard): WorkflowFailureHit[] => {
  const before = readRunningWorkflows(previous)
  const hits: WorkflowFailureHit[] = []
  for (const [threadId, agent] of readRunningWorkflows(next)) {
    const prior = before.get(threadId)
    if (!prior || isCatastrophic(prior.workflowCounts) || !isCatastrophic(agent.workflowCounts)) continue
    hits.push({ threadId, label: agent.nickname ?? agent.role ?? threadId, counts: agent.workflowCounts! })
  }
  return hits
}

export const buildWorkflowFailureWakePrompt = (hit: WorkflowFailureHit, language: AppLanguage) => {
  const { done, running, failed, total, catastrophic = 0, catastrophicSample } = hit.counts
  if (language === 'en') {
    const sample = catastrophicSample ? ` Latest error: ${catastrophicSample}.` : ''
    return `[Chill Vibe auto notice] Background Workflow "${hit.label}": ${catastrophic} sub-agents died of infrastructure errors (429 / overloaded / 5xx / timeout / network); ${failed}/${total} failed overall (${done} done, ${running} running).${sample} Check its progress now. If the upstream is clearly down or the running agents have produced nothing for a long time, stop it with TaskStop and tell the user what failed instead of waiting for a degraded result; if it is still worth continuing, say so briefly and end the turn.`
  }
  const sample = catastrophicSample ? `最近一条报错：${catastrophicSample}。` : ''
  return `[Chill Vibe 自动提醒] 后台 Workflow「${hit.label}」已有 ${catastrophic} 个子 agent 死于基础设施错误（429 / 过载 / 5xx / 超时 / 断网），总计失败 ${failed}/${total}（已完成 ${done}，在跑 ${running}）。${sample}请现在检查它的进度：如果上游明显在出事，或在跑的子 agent 长时间零输出，就用 TaskStop 停掉并告诉用户哪里失败了，不要干等残缺结果；如果仍值得继续，简短说明后结束本轮。`
}
