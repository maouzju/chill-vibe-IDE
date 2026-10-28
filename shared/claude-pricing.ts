import type { ClaudeUsageModelFamily } from './schema.js'

/**
 * Claude API 公开定价，用于用量统计的**估算**（docs/specs/claude-usage-ledger FR-3）。
 *
 * 数值照抄 外部 token-dashboard 面板的 prices.json；来源
 * platform.claude.com/docs/en/about-claude/pricing，抄录日期见 CLAUDE_PRICING_COPIED_ON。
 * 单位：美元 / 百万 token，五档 [输入, 输出, 缓存写入(5 分钟), 缓存写入(1 小时), 缓存读取]。
 *
 * 这不是模型选择器里的标价（fable-5-1-upgrade 的「不展示定价字段」说的是那边）；
 * 这里只服务统计卡的费用折算。
 */
export const CLAUDE_PRICING_COPIED_ON = '2026-10-28'
export const CLAUDE_PRICING_SOURCE_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'

export type ClaudePriceRow = readonly [
  input: number,
  output: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
]

/** `@long`：Haiku 5.5 单次请求提示词（输入 + 缓存写 + 缓存读）超过 10 万 token 时的高价档。 */
export const CLAUDE_HAIKU_LONG_CONTEXT_THRESHOLD = 100_000

export const claudePriceTable: Readonly<Record<string, ClaudePriceRow>> = {
  'claude-fable-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-mythos-5-1': [10, 50, 12.5, 20, 0.25],
  'claude-fable-5': [10, 50, 12.5, 20, 1],
  'claude-mythos-5': [10, 50, 12.5, 20, 1],
  'claude-opus-5-5': [4, 20, 5, 8, 0.2],
  'claude-opus-5': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4': [5, 25, 6.25, 10, 0.5],
  'claude-opus-4-1': [15, 75, 18.75, 30, 1.5],
  'claude-opus-4-2025': [15, 75, 18.75, 30, 1.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.1],
  'claude-sonnet-5': [2, 10, 2.5, 4, 0.2],
  'claude-sonnet-4': [3, 15, 3.75, 6, 0.3],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
  'claude-haiku-5-5@long': [0.5, 2.5, 0.625, 1, 0.05],
  'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  'claude-3-5-haiku': [0.8, 4, 1, 1.6, 0.08],
  // 系列默认价：没收录的新型号退回这里
  fable: [10, 50, 12.5, 20, 0.25],
  opus: [4, 20, 5, 8, 0.2],
  sonnet: [2, 10, 2.5, 4, 0.1],
  haiku: [0.1, 0.5, 0.125, 0.2, 0.01],
}

const LONG_SUFFIX = '@long'

/**
 * 型号 → 系列。mythos 与 fable 同价同族（token-dashboard 的 fam() 认不出 mythos，
 * 那些行会被整个跳过；这里把它并进 fable，宁可按同价计也不丢）。
 */
export const resolveClaudeModelFamily = (model: string | null | undefined): ClaudeUsageModelFamily | null => {
  const lower = (model ?? '').toLowerCase()
  if (lower.includes('fable') || lower.includes('mythos')) return 'fable'
  if (lower.includes('haiku')) return 'haiku'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('opus')) return 'opus'
  return null
}

/** `claude-opus-4.1` → `claude-opus-4-1`：定价表的键统一用连字符。 */
const normalizeModelId = (model: string) => model.toLowerCase().replace(/(\d)\.(\d)/g, '$1-$2')

/**
 * 入账时定下的价格键：规范化后的型号，Haiku 5.5 超长提示词再带 `@long`。
 * 之所以在入账时定而不是查询时：`@long` 取决于**那一次请求**的 token 数，聚合之后就看不见了。
 */
export const resolveClaudePriceKey = (model: string, promptTokens: number) => {
  const normalized = normalizeModelId(model)
  if (normalized.includes('haiku-5-5') && promptTokens > CLAUDE_HAIKU_LONG_CONTEXT_THRESHOLD) {
    return `${normalized}${LONG_SUFFIX}`
  }
  return normalized
}

/** 按型号前缀取最长匹配；`@long` 只匹配 `@long` 键；没收录的退回同系列默认价，再不行按 opus。 */
export const resolveClaudePriceRow = (priceKey: string): ClaudePriceRow => {
  const normalized = normalizeModelId(priceKey)
  const wantsLong = normalized.endsWith(LONG_SUFFIX)
  const bare = wantsLong ? normalized.slice(0, -LONG_SUFFIX.length) : normalized

  let best: string | null = null
  for (const key of Object.keys(claudePriceTable)) {
    const keyIsLong = key.endsWith(LONG_SUFFIX)
    if (keyIsLong !== wantsLong) continue
    const keyBare = keyIsLong ? key.slice(0, -LONG_SUFFIX.length) : key
    if (bare.startsWith(keyBare) && (best === null || keyBare.length > best.length - (best.endsWith(LONG_SUFFIX) ? LONG_SUFFIX.length : 0))) {
      best = key
    }
  }

  if (best) return claudePriceTable[best]!
  const family = resolveClaudeModelFamily(bare)
  return claudePriceTable[family ?? 'opus']!
}

export type ClaudeUsageTokenBuckets = {
  input: number
  output: number
  /** 缓存写入总量（含 1 小时部分）。 */
  cacheWrite: number
  /** 其中按 1 小时档计价的部分。 */
  cacheWrite1h: number
  cacheRead: number
}

export const estimateClaudeCostUsd = (priceKey: string, tokens: ClaudeUsageTokenBuckets) => {
  const [input, output, cacheWrite5m, cacheWrite1h, cacheRead] = resolveClaudePriceRow(priceKey)
  const write1h = Math.min(tokens.cacheWrite1h, tokens.cacheWrite)
  return (
    (tokens.input * input +
      tokens.output * output +
      (tokens.cacheWrite - write1h) * cacheWrite5m +
      write1h * cacheWrite1h +
      tokens.cacheRead * cacheRead) /
    1e6
  )
}
