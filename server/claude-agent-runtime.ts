import type { AppLanguage, StreamAgentsActivity } from '../shared/schema.js'
import { createClaudeAgentStatusTracker, syntheticClaudeAgentId } from './claude-agent-status.js'
import type { ClaudeCompletionBoundary } from './claude-completion-boundary.js'

// 回合结束不代表后台 Workflow 结束（2026-09-08 原生回执实证）。
// 时钟归属于长驻进程，不向已经 done 的聊天流继续写事件。
export const createClaudeAgentRuntime = (options: {
  language: AppLanguage
  publish: (activity: StreamAgentsActivity) => void
  readCompletionBoundary: () => ClaudeCompletionBoundary
}) => {
  const tracker = createClaudeAgentStatusTracker({ language: options.language })
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  let published = false
  const publish = (activity = tracker.snapshot()) => {
    published = true
    options.publish(activity)
    if (tracker.hasRunningAgents() && !timer) {
      timer = setInterval(() => options.publish(tracker.snapshot()), 15_000)
      timer.unref?.()
    } else if (!tracker.hasRunningAgents() && timer) {
      clearInterval(timer)
      timer = undefined
    }
  }
  return {
    onLine(line: string) {
      if (disposed) return
      let event: Record<string, unknown>
      try { event = JSON.parse(line) } catch { return }
      if (!event || typeof event !== 'object' || event.parent_tool_use_id) return
      if (event.type === 'assistant') {
        const content = (event.message as { content?: unknown } | undefined)?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'tool_use' && typeof block.id === 'string' && ['Workflow', 'Task', 'Agent'].includes(block.name)) {
              publish(tracker.beginSynthetic(syntheticClaudeAgentId(block.id), block.name))
            }
          }
        }
      }
      const update = tracker.handleEvent(event)
      if (update.activity) publish(update.activity)
      if (event.type === 'result' && published) {
        const boundary = options.readCompletionBoundary()
        const keep = !event.is_error && (boundary === 'background-pending' || (boundary === 'unknown' && tracker.hasBackgroundAgents()))
        // 回合报错只中断本回合的条目；仍在后台跑的 Workflow 不归这一回合管，
        // 否则它真正完成时的 task_notification 会撞上终态守卫，面板永远不恢复。
        publish(event.is_error ? tracker.finishTurn(true, 'interrupted') : tracker.finishTurn(keep))
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      timer = undefined
      if (published) options.publish(tracker.settleAll('interrupted'))
    },
  }
}
