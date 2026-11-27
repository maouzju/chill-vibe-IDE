// Agent 声明「会话未完成」约定。规格见 docs/specs/agent-declared-pending。
//
// 症状（2026-11-27 用户报）：agent 起了后台构建 / 等 CI / 等别的会话后先结束回复，Chill Vibe
//   当成整件事做完：响完成音、放行等它的计时唤醒、看板挪道、Auto-Urge 鞭策……链式误触发。
// 根因：原生边界只认 CLI 自己登记的后台任务（Claude Stop 钩子），agent 自己拉起的外部进程、
//   Codex / Gemini 全部没有信号。
// 被否决：从回复文本猜「还在等」——误判面太大；这里只认 agent 显式写下的标记，且必有上界（到点自查）。

import type { AppLanguage, CardStatus } from './schema.js'

export const AGENT_PENDING_TAG = 'chill-vibe-pending'
export const AGENT_PENDING_DEFAULT_MINUTES = 30
export const AGENT_PENDING_MIN_MINUTES = 1
export const AGENT_PENDING_MAX_MINUTES = 240
/** 连续自动自查的上限；超过就清标记，不再自动发。 */
export const AGENT_PENDING_MAX_CHECK_INS = 8

export type AgentPendingMarker = {
  reason: string
  minutes: number
}

const markerGlobalPattern = /<chill-vibe-pending\b([^>]*)>([\s\S]*?)<\/chill-vibe-pending\s*>/gi
const unclosedTailPattern = /<chill-vibe-pending\b(?![\s\S]*<\/chill-vibe-pending)[\s\S]*$/i
const minutesAttributePattern = /\bminutes\s*=\s*["']?([^"'\s>]*)/i
const fencedCodePattern = /```[\s\S]*?(?:```|$)/g

const clampMinutes = (raw: string | undefined) => {
  const value = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(value)) {
    return AGENT_PENDING_DEFAULT_MINUTES
  }
  return Math.min(AGENT_PENDING_MAX_MINUTES, Math.max(AGENT_PENDING_MIN_MINUTES, value))
}

export const parseAgentPendingMarker = (text: string | undefined | null): AgentPendingMarker | null => {
  if (!text || !text.includes(AGENT_PENDING_TAG)) {
    return null
  }

  // 代码块里的标记是在「讲」约定，不是在「用」约定。
  const visible = text.replace(fencedCodePattern, '')
  let last: RegExpExecArray | null = null
  for (const match of visible.matchAll(markerGlobalPattern)) {
    last = match
  }
  if (!last) {
    return null
  }

  const attributes = last[1] ?? ''
  const reason = (last[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    reason: reason || 'Background work',
    minutes: clampMinutes(minutesAttributePattern.exec(attributes)?.[1]),
  }
}

export const stripAgentPendingMarkers = (text: string) => {
  if (!text.includes('<chill-vibe-pending')) {
    return text
  }
  return text
    .replace(markerGlobalPattern, '')
    .replace(unclosedTailPattern, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type PendingCardShape = {
  status?: CardStatus
  backgroundWorkPending?: boolean
  agentPendingUntil?: string
}

export const isAgentDeclaredPending = (card: PendingCardShape) =>
  card.backgroundWorkPending === true &&
  typeof card.agentPendingUntil === 'string' &&
  card.agentPendingUntil.length > 0

export const planAgentPendingDeadlines = (
  cards: ReadonlyArray<PendingCardShape & { id: string }>,
  now: number,
) => {
  const due: string[] = []
  let nextAt: number | undefined

  for (const card of cards) {
    if (card.status === 'streaming' || !isAgentDeclaredPending(card)) {
      continue
    }
    const at = Date.parse(card.agentPendingUntil!)
    if (!Number.isFinite(at) || at <= now) {
      due.push(card.id)
      continue
    }
    nextAt = nextAt === undefined ? at : Math.min(nextAt, at)
  }

  return { due, nextAt }
}

export const buildAgentPendingInstruction = (language: AppLanguage) =>
  language === 'en'
    ? `Unfinished-session marker: when you end a turn while work you started is still running in the background and someone has to come back to it (a detached build/package/long test started with Start-Process/nohup, a dev server you still need to verify, a remote CI/release run, another session's output you are waiting for), finish your reply with exactly one marker on its own line: <${AGENT_PENDING_TAG} minutes="N">one short line saying what you are waiting for</${AGENT_PENDING_TAG}>. N is when to check back (1-240, default 30). Chill Vibe then keeps this session marked as not finished (no completion sound, timers waiting on you stay blocked, automation boards do not advance) and sends you a check-in message at that time. On check-in, inspect the background work: if it is done, report the result normally without the marker; if not, end with a new marker. Do not use the marker when everything is finished, when you need the user to decide something, or just because you are waiting for the user's reply; native background Agents/Workflows you are already tracking do not need it.`
    : `会话未完成标记：当你结束本轮回复时，自己发起的工作仍在后台运行、之后必须回来检查（例如用 Start-Process / nohup 拉起的构建、打包、长测试，还要验证的开发服务器，远端 CI / 发布流程，正在等的其他会话产出），就在回复最后单独一行写且只写一个标记：<${AGENT_PENDING_TAG} minutes="N">一句话说明在等什么</${AGENT_PENDING_TAG}>。N 是多少分钟后回来查看（1-240，默认 30）。Chill Vibe 会据此把这个会话标为「未完成」（不响完成提示、等你的计时唤醒继续等待、自动化看板不推进），并在到点时给你发一条自查消息。收到自查时检查后台工作：已经完成就正常汇报结果、不要再带标记；还没完成就在末尾重新带上标记。全部完成、需要用户做决定、或只是在等用户回复时都不要用这个标记；已经由原生后台 Agent / Workflow 跟踪的任务也不需要。`

export const buildAgentPendingCheckInPrompt = (reason: string, language: AppLanguage) =>
  language === 'en'
    ? `[Chill Vibe check-in] The background work you marked as unfinished is due: ${reason}. Check its progress now. If it is done, report the result normally without the marker; if it is still running, end your reply with a new <${AGENT_PENDING_TAG} minutes="N">…</${AGENT_PENDING_TAG}> marker.`
    : `【Chill Vibe 自查】你标记为未完成的后台工作到了查看时间：${reason}。现在检查进度：已完成就正常汇报结果、不要带标记；还在跑就在回复末尾重新带上 <${AGENT_PENDING_TAG} minutes="N">…</${AGENT_PENDING_TAG}> 标记。`

export const buildAgentPendingGiveUpNotice = (language: AppLanguage) =>
  language === 'en'
    ? `Chill Vibe stopped automatic check-ins after ${AGENT_PENDING_MAX_CHECK_INS} rounds and cleared the unfinished marker. Send a message if the background work still needs follow-up.`
    : `已连续自动自查 ${AGENT_PENDING_MAX_CHECK_INS} 次，后台仍未完成。Chill Vibe 已清除「未完成」标记、不再自动叫醒；如需继续跟进请手动发消息。`
