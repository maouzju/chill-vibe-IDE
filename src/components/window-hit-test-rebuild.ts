import type { HitTestRepairScope } from './composer-focus'

// 症状：2026-09-08 用户报"极小概率所有输入框无法悬停聚焦，缩小窗口后自愈"。
// 根因：卡级 / 面板级 `is-hit-test-repair` 只重建自己子树的合成层（pitfall
// #129），对窗口级的陈旧 hit-test（frameless 拖拽区缓存、窗口 surface 陈旧）
// 无效；帧看门狗只在"10s 无新帧"时 invalidate()，帧正常但事件误路由时永不
// 开火（main.log 08-24 起零 frame stall）。用户手动改窗口尺寸能恢复，说明
// 需要的是几何重算不是重绘。
// 被否决的替代：直接在每次误路由时抖窗口——正常使用里偶发单次误路由（菜单
// 收起瞬间）也会触发，会把一个自愈动作变成可感知的抖动。这里只在两种
// "子树重建已证明无效"的形态上升级：多张卡在同一观察窗内都误路由（卡级
// 重建不可能同时救所有卡），或面板级重建之后同一张卡仍然误路由。

export type WindowHitTestRebuildEntry = {
  atMs: number
  cardKey: string
  scope: Exclude<HitTestRepairScope, 'skip'>
}

export type WindowHitTestRebuildDecision = 'none' | 'request'

// Wider than the card escalation window (5s) so a card → panel → still-broken
// sequence fits inside one observation; the cooldown must exceed it so one
// stubborn surface cannot turn the window nudge into a periodic twitch.
export const windowHitTestRebuildWindowMs = 15_000
export const windowHitTestRebuildCooldownMs = 60_000

export const decideWindowHitTestRebuild = (
  entries: readonly WindowHitTestRebuildEntry[],
  nowMs: number,
  lastRequestAtMs: number | null,
  options?: { windowMs?: number; cooldownMs?: number },
): WindowHitTestRebuildDecision => {
  const windowMs = options?.windowMs ?? windowHitTestRebuildWindowMs
  const cooldownMs = options?.cooldownMs ?? windowHitTestRebuildCooldownMs

  if (lastRequestAtMs !== null && nowMs - lastRequestAtMs < cooldownMs) {
    return 'none'
  }

  const recent = entries.filter((entry) => nowMs - entry.atMs <= windowMs)
  if (recent.length < 2) {
    return 'none'
  }

  const distinctCards = new Set(recent.map((entry) => entry.cardKey))
  if (distinctCards.size >= 2) {
    return 'request'
  }

  const panelEscalations = recent.filter((entry) => entry.scope === 'card-and-panel').length
  return panelEscalations >= 2 ? 'request' : 'none'
}

export type WindowHitTestRebuildTracker = {
  note: (entry: WindowHitTestRebuildEntry) => WindowHitTestRebuildDecision
  lastRequestAtMs: () => number | null
}

export const createWindowHitTestRebuildTracker = (options?: {
  windowMs?: number
  cooldownMs?: number
}): WindowHitTestRebuildTracker => {
  const windowMs = options?.windowMs ?? windowHitTestRebuildWindowMs
  let entries: WindowHitTestRebuildEntry[] = []
  let lastRequestAtMs: number | null = null

  return {
    note: (entry) => {
      entries = [...entries.filter((existing) => entry.atMs - existing.atMs <= windowMs), entry]
      const decision = decideWindowHitTestRebuild(entries, entry.atMs, lastRequestAtMs, options)
      if (decision === 'request') {
        lastRequestAtMs = entry.atMs
        entries = []
      }
      return decision
    },
    lastRequestAtMs: () => lastRequestAtMs,
  }
}
