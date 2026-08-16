import { z } from 'zod'

import {
  DEFAULT_BRAINSTORM_ANSWER_COUNT,
  MAX_BRAINSTORM_ANSWER_COUNT,
  MIN_BRAINSTORM_ANSWER_COUNT,
} from './brainstorm.js'
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_GIT_AGENT_MODEL } from './models.js'
import { defaultSystemPrompt } from './system-prompt.js'

export const providerSchema = z.enum(['codex', 'claude'])
export type Provider = z.infer<typeof providerSchema>

export const streamErrorHintSchema = z.enum(['switch-config', 'env-setup'])
export type StreamErrorHint = z.infer<typeof streamErrorHintSchema>

export const chatActivityKindSchema = z.enum(['command', 'reasoning', 'tool', 'edits', 'todo', 'ask-user', 'agents'])
export type ChatActivityKind = z.infer<typeof chatActivityKindSchema>

export const chatCommandActivityStatusSchema = z.enum(['in_progress', 'completed', 'failed', 'declined'])
export type ChatCommandActivityStatus = z.infer<typeof chatCommandActivityStatusSchema>

export const slashCommandSourceSchema = z.enum(['app', 'native', 'skill'])
export type SlashCommandSource = z.infer<typeof slashCommandSourceSchema>

export const slashCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  source: slashCommandSourceSchema.default('native'),
  skillProvider: providerSchema.optional(),
  skillPath: z.string().optional(),
})
export type SlashCommand = z.infer<typeof slashCommandSchema>

export const themeSchema = z.enum(['light', 'dark', 'system', 'custom'])
export type AppTheme = z.infer<typeof themeSchema>

export const customThemeBaseSchema = z.enum(['light', 'dark'])
export type CustomThemeBase = z.infer<typeof customThemeBaseSchema>

export const fontFamilySchema = z.enum(['default', 'system', 'aptos', 'segoe-ui', 'arial', 'microsoft-yahei', 'dengxian', 'simsun', 'simhei', 'kaiti', 'fangsong', 'serif', 'georgia', 'times-new-roman', 'mono', 'cascadia-code', 'consolas'])
export type AppFontFamily = z.infer<typeof fontFamilySchema>

export const appLanguageSchema = z.enum(['zh-CN', 'en'])
export type AppLanguage = z.infer<typeof appLanguageSchema>

export const topTabNameSchema = z.enum(['ambience', 'routing', 'settings'])
export type TopTabName = z.infer<typeof topTabNameSchema>

export const cardStatusSchema = z.enum(['idle', 'streaming', 'error'])
export type CardStatus = z.infer<typeof cardStatusSchema>

export const codexApprovalPolicySchema = z.enum(['never', 'on-request'])
export type CodexApprovalPolicy = z.infer<typeof codexApprovalPolicySchema>

export const chatRoleSchema = z.enum(['user', 'assistant', 'system'])
export type ChatRole = z.infer<typeof chatRoleSchema>

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: chatRoleSchema,
  content: z.string(),
  createdAt: z.string().datetime(),
  meta: z.record(z.string(), z.string()).optional(),
})
export type ChatMessage = z.infer<typeof chatMessageSchema>

export const imageAttachmentMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
export type ImageAttachmentMimeType = z.infer<typeof imageAttachmentMimeTypeSchema>

export const imageAttachmentSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: imageAttachmentMimeTypeSchema,
  sizeBytes: z.number().int().positive(),
})
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>

export const queuedSendRequestSchema = z.object({
  id: z.string().min(1),
  prompt: z.string(),
  attachments: z.array(imageAttachmentSchema).default([]),
  isContinuation: z.literal(true).optional(),
}).refine(
  (request) =>
    request.prompt.trim().length > 0 ||
    request.attachments.length > 0 ||
    request.isContinuation === true,
  { message: 'Queued send must include a prompt, attachment, or explicit continuation.' },
)
export type QueuedSendRequest = z.infer<typeof queuedSendRequestSchema>

// A plain queue entry that carries neither prompt nor attachment is meaningless,
// but on 2026-07-26 one reached state.json and made every later save fatal. The
// only valid empty entry is an explicit "continue from here" intent, marked by
// isContinuation; recovery must still drop every unmarked empty entry.
export const persistedQueuedSendsSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((entry) => queuedSendRequestSchema.safeParse(entry).success)
      : value,
  z.array(queuedSendRequestSchema),
)

export const wakeTimerModes = ['workspace-agents', 'left-tab', 'duration'] as const
export const wakeTimerModeSchema = z.enum(wakeTimerModes)
export type WakeTimerMode = z.infer<typeof wakeTimerModeSchema>
export const minWakeTimerDurationMinutes = 1
export const maxWakeTimerDurationMinutes = 7 * 24 * 60
export const defaultWakeTimerDurationMinutes = 30

export const brainstormAnswerStatusSchema = z.enum(['streaming', 'done', 'error'])
export type BrainstormAnswerStatus = z.infer<typeof brainstormAnswerStatusSchema>

export const brainstormAnswerSchema = z.object({
  id: z.string().min(1),
  content: z.string().default(''),
  status: brainstormAnswerStatusSchema.default('streaming'),
  streamId: z.string().min(1).optional(),
  error: z.string().default(''),
})
export type BrainstormAnswer = z.infer<typeof brainstormAnswerSchema>

export const brainstormStateSchema = z.object({
  prompt: z.string().default(''),
  provider: providerSchema.default('codex'),
  model: z.string().default(DEFAULT_CODEX_MODEL),
  answerCount: z
    .number()
    .int()
    .min(MIN_BRAINSTORM_ANSWER_COUNT)
    .max(MAX_BRAINSTORM_ANSWER_COUNT)
    .default(DEFAULT_BRAINSTORM_ANSWER_COUNT),
  answers: z.array(brainstormAnswerSchema).default([]),
  failedAnswers: z.array(z.string()).default([]),
})
export type BrainstormState = z.infer<typeof brainstormStateSchema>

export const pmStateSchema = z.object({
  provider: providerSchema.default('codex'),
  model: z.string().default(DEFAULT_CODEX_MODEL),
})
export type PmState = z.infer<typeof pmStateSchema>

export const contextTransferSchema = z.object({
  sourceProvider: providerSchema,
  sourceModel: z.string().min(1),
  sourceSessionId: z.string().min(1).optional(),
})
export type ContextTransfer = z.infer<typeof contextTransferSchema>

export const automationBoardLanes = ['standby', 'running', 'done'] as const
export const automationBoardLaneSchema = z.enum(automationBoardLanes)
export type AutomationBoardLane = z.infer<typeof automationBoardLaneSchema>

export const automationBoardRequirementMaxChars = 4000

export const automationBoardItemSchema = z.object({
  cardId: z.string().min(1),
  lane: automationBoardLaneSchema,
  // 冗余存一份原始需求是刻意的：监工要"检查每个原始需求"，而
  // card.messages[0] 会被 /compact、消息裁剪和 sidecar 归档拿走。
  requirement: z.string().default(''),
  // 由哪个模板实例化而来（手动新建的项为空串）。这是模板触发器**防自触发**
  // 的唯一依据：一个模板触发出来的项跑完时不能再把同一个模板叫起来。
  templateId: z.string().default(''),
  createdAt: z.string().datetime().optional(),
  // 进入 running 道的时刻，供监工判断"超过半小时没下文"。
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})
export type AutomationBoardItem = z.infer<typeof automationBoardItemSchema>

// 用户拖出来的泳道宽度。存的是**比例**不是像素：看板宽度由外层列宽与 pane 分屏
// 决定、随时在变，像素值第二天就对不上。三个数只有相对大小有意义，渲染时转成 fr。
export const automationBoardLaneWidthsSchema = z.object({
  standby: z.number().finite().positive(),
  running: z.number().finite().positive(),
  done: z.number().finite().positive(),
})
export type AutomationBoardLaneWidths = z.infer<typeof automationBoardLaneWidthsSchema>

// 「加入待命」输入区上次选的执行参数。v2.0 把它放在组件 useState 里，理由是
// "落盘会让用户被上次的一次性选择绑住"；实际使用推翻了这条 —— 连着加十个需求项
// 要重选十次，切走再回来又回到列默认。绑住是想象的成本，重选是真实的成本。
//
// reasoningEffort 默认空串而不是 'max'：空串的语义是"跟着 provider/model 的默认
// 走"，渲染时经 normalizeReasoningEffortForModel 解析。写死 'max' 会让不支持该
// 档位的 Codex 老模型一开箱就带一个非法档。
export const automationBoardComposeDefaultsSchema = z.object({
  provider: providerSchema.default('codex'),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  thinkingEnabled: z.boolean().default(true),
  planMode: z.boolean().default(false),
  adminAccess: z.boolean().default(false),
})
export type AutomationBoardComposeDefaults = z.infer<typeof automationBoardComposeDefaultsSchema>

export const automationBoardSchema = z.object({
  // 泳道内顺序 = 本数组内的相对顺序（按 lane 过滤后保序）。
  items: z.array(automationBoardItemSchema).default([]),
  // optional 而非 default：没调过宽度的看板不该往 state.json 里塞一份等于默认值
  // 的对象，"从没调过"与"调回均分"在磁盘上也该是同一种状态。
  laneWidths: automationBoardLaneWidthsSchema.optional(),
  // 同样 optional 同样的理由：没动过设置的看板不该凭空长出这个字段。
  composeDefaults: automationBoardComposeDefaultsSchema.optional(),
  /**
   * 「加入待命」输入框里还没提交的文本。
   *
   * 症状：写了半页需求，切一下同 pane 的别的 tab 回来就空了，重启更空。
   * 根因：它只活在组件 useState 里，而看板不在 `cardKeepsPaneRuntimeWhenInactive`
   *   的白名单里（只有 Git 卡在），tab 一切走整棵子树就卸载 —— 普通聊天卡靠
   *   `card.draft` 扛住的那件事，这里一点都没有。
   * 为什么不用看板卡自己闲着的 `card.draft`：那份随卡片一起消失，而看板的编排
   *   现在是工作区级的（FR13），草稿跟着编排走才不会"关掉 tab 再开，项都回来了
   *   只有正在写的那句没了"。
   */
  // optional 而非 default('')：和上面两个字段同一条规矩 —— 没写过草稿的看板不该
  // 在 state.json 里多一个空串。
  draft: z.string().optional(),
})
export type AutomationBoard = z.infer<typeof automationBoardSchema>

export const chatCardSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  sessionId: z.string().optional(),
  sessionModel: z.string().optional(),
  providerSessions: z.record(z.string(), z.string()).default({}),
  contextTransfer: contextTransferSchema.optional(),
  streamId: z.string().min(1).optional(),
  status: cardStatusSchema,
  size: z.number().positive().optional(),
  provider: providerSchema.default('codex'),
  model: z.string().default(''),
  reasoningEffort: z.string().default('max'),
  thinkingEnabled: z.boolean().default(true),
  planMode: z.boolean().default(false),
  autoUrgeActive: z.boolean().default(false),
  autoUrgeProfileId: z.string().default('auto-urge-default'),
  repeatLoopActive: z.boolean().optional(),
  repeatLoopRemaining: z.number().int().min(0).optional(),
  collapsed: z.boolean().default(false),
  unread: z.boolean().default(false),
  completionGlow: z.boolean().optional(),
  backgroundWorkPending: z.boolean().optional(),
  draft: z.string().default(''),
  draftAttachments: z.array(imageAttachmentSchema).default([]),
  queuedSends: z.array(queuedSendRequestSchema).default([]),
  wakeTimerActive: z.boolean().optional(),
  // 这次的开关是右键发送替用户打开的，不是用户自己在设置里开的。
  // 刻意跟 wakeTimerActive 一样保持 optional：旧存档缺这个字段时读成 undefined，
  // 判定按 `=== true` 走，也就是当作用户显式开启，绝不自动关。
  wakeTimerAutoActivated: z.boolean().optional(),
  wakeTimerMode: wakeTimerModeSchema.optional(),
  wakeTimerDurationMinutes: z.number().finite().min(minWakeTimerDurationMinutes).max(maxWakeTimerDurationMinutes).optional(),
  wakeTimerQueuedSends: persistedQueuedSendsSchema.optional(),
  wakeTimerArmedAt: z.string().datetime().optional(),
  wakeTimerWakeAt: z.string().datetime().optional(),
  wakeTimerPendingTargetIds: z.array(z.string().min(1)).optional(),
  stickyNote: z.string().default(''),
  stickyNoteId: z.string().min(1).optional(),
  stickyNoteViewState: z.object({
    scrollTop: z.number().nonnegative().default(0),
    selectionStart: z.number().int().nonnegative().default(0),
    selectionEnd: z.number().int().nonnegative().default(0),
  }).optional(),
  brainstorm: brainstormStateSchema.default({
    prompt: '',
    provider: 'codex',
    model: DEFAULT_CODEX_MODEL,
    answerCount: DEFAULT_BRAINSTORM_ANSWER_COUNT,
    answers: [],
    failedAnswers: [],
  }),
  pm: pmStateSchema.optional(),
  pmTaskCardId: z.string().default('').optional(),
  pmOwnerCardId: z.string().default('').optional(),
  // Only present on `__automationboard_tool__` cards. Deliberately optional
  // rather than defaulted: every ordinary card would otherwise carry an empty
  // object into state.json for no benefit.
  automationBoard: automationBoardSchema.optional(),
  // 超管权限：这个会话可以读写**同一工作区列里的其他会话**（列出/鞭策/换道/
  // 挂唤醒）。任何卡片都能开，默认关。optional 而非 default 的理由同上。
  // 关闭时 provider 启动里完全没有这组 MCP —— 这是权限边界，不只是优化。
  adminAccess: z.boolean().optional(),
  // 症状（要防的）：监工被「拖出为独立 tab」再拖回泳道之后，每答完一轮就把自己
  //   再叫起来一轮，无限自触发烧钱。
  // 根因：防自触发认的是 `board.items[].templateId`，而拖出会把整条项删掉；拖回
  //   时只能补一个空 templateId，血缘就断在中间那段"它只是一张普通 tab"里。
  // 为什么不能换写法：血缘必须活在**卡片**上才能跨越那段没有项的时期。搬运两端
  //   都不改卡（对象身份不变是无缝性的硬要求），所以只在拖出那一刻写一次。
  automationBoardTemplateId: z.string().optional(),
  messages: z.array(chatMessageSchema).default([]),
  messageCount: z.number().int().nonnegative().optional(),
})
export type ChatCard = z.infer<typeof chatCardSchema>

export type SplitDirection = 'horizontal' | 'vertical'

export type PaneNode = {
  type: 'pane'
  id: string
  tabs: string[]
  activeTabId: string
  tabHistory?: string[]
}

export type SplitNode = {
  type: 'split'
  id: string
  direction: SplitDirection
  children: LayoutNode[]
  ratios: number[]
}

export type LayoutNode = PaneNode | SplitNode

export const splitDirectionSchema = z.enum(['horizontal', 'vertical'])
export type SplitDirectionSchema = z.infer<typeof splitDirectionSchema>

export const paneNodeSchema: z.ZodType<PaneNode> = z.object({
  type: z.literal('pane'),
  id: z.string().min(1),
  tabs: z.array(z.string().min(1)).default([]),
  activeTabId: z.string().default(''),
  tabHistory: z.array(z.string().min(1)).default([]),
})

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([splitNodeSchema, paneNodeSchema]),
)

export const splitNodeSchema: z.ZodType<SplitNode> = z
  .object({
    type: z.literal('split'),
    id: z.string().min(1),
    direction: splitDirectionSchema,
    children: z.array(layoutNodeSchema).min(2),
    ratios: z.array(z.number().finite().positive()).min(2),
  })
  .superRefine((value, ctx) => {
    if (value.children.length !== value.ratios.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ratios'],
        message: 'Split ratios must match the number of children.',
      })
    }
  })

export const boardColumnSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  provider: providerSchema,
  workspacePath: z.string(),
  model: z.string(),
  width: z.number().finite().positive().optional(),
  layout: layoutNodeSchema,
  cards: z.record(z.string(), chatCardSchema),
})
export type BoardColumn = z.infer<typeof boardColumnSchema>

export const requestModelSettingsSchema = z.object({
  codex: z.string().default(DEFAULT_CODEX_MODEL),
  claude: z.string().default(DEFAULT_CLAUDE_MODEL),
})
export type RequestModelSettings = z.infer<typeof requestModelSettingsSchema>

export const modelPromptRuleSchema = z.object({
  id: z.string().min(1),
  modelMatch: z.string().min(1),
  prompt: z.string().min(1),
})
export type ModelPromptRule = z.infer<typeof modelPromptRuleSchema>

export const modelReasoningEffortsSchema = z.object({
  codex: z.record(z.string(), z.string()).default({}),
  claude: z.record(z.string(), z.string()).default({}),
})
export type ModelReasoningEfforts = z.infer<typeof modelReasoningEffortsSchema>

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

export const providerProfileCollectionSchema = z.object({
  activeProfileId: z.string().default(''),
  profiles: z.array(providerProfileSchema).default([]),
})
export type ProviderProfileCollection = z.infer<typeof providerProfileCollectionSchema>

export const providerProfilesSchema = z.object({
  codex: providerProfileCollectionSchema.default({
    activeProfileId: '',
    profiles: [],
  }),
  claude: providerProfileCollectionSchema.default({
    activeProfileId: '',
    profiles: [],
  }),
})
export type ProviderProfiles = z.infer<typeof providerProfilesSchema>

export const recentWorkspaceSchema = z.object({
  path: z.string().min(1),
  openedAt: z.string().datetime(),
})
export type RecentWorkspace = z.infer<typeof recentWorkspaceSchema>

export const sessionHistoryEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sessionId: z.string().optional(),
  sessionModel: z.string().optional(),
  contextTransfer: contextTransferSchema.optional(),
  provider: providerSchema,
  model: z.string().default(''),
  workspacePath: z.string().min(1),
  messages: z.array(chatMessageSchema).default([]),
  messageCount: z.number().int().nonnegative().optional(),
  messagesPreview: z.boolean().optional(),
  workspaceCloseId: z.string().min(1).optional(),
  archivedAt: z.string().datetime(),
})
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>

export const closedWorkspaceSnapshotSchema = z.object({
  closeId: z.string().min(1),
  closedAt: z.string().datetime(),
  column: boardColumnSchema,
})
export type ClosedWorkspaceSnapshot = z.infer<typeof closedWorkspaceSnapshotSchema>

export const closedWorkspaceLoadRequestSchema = z.object({
  workspacePath: z.string().trim().min(1),
})
export type ClosedWorkspaceLoadRequest = z.infer<typeof closedWorkspaceLoadRequestSchema>

export const closedWorkspaceLoadResponseSchema = z.object({
  snapshot: closedWorkspaceSnapshotSchema.nullable(),
  legacyEntryIds: z.array(z.string().min(1)).default([]),
})
export type ClosedWorkspaceLoadResponse = z.infer<typeof closedWorkspaceLoadResponseSchema>

export const internalSessionHistoryLoadRequestSchema = z.object({
  entryId: z.string().min(1),
})
export type InternalSessionHistoryLoadRequest = z.infer<typeof internalSessionHistoryLoadRequestSchema>

export const internalSessionHistoryLoadResponseSchema = z.object({
  entry: sessionHistoryEntrySchema,
})
export type InternalSessionHistoryLoadResponse = z.infer<typeof internalSessionHistoryLoadResponseSchema>

export const dataMaintenancePhaseSchema = z.enum(['idle', 'running', 'complete', 'degraded'])
export type DataMaintenancePhase = z.infer<typeof dataMaintenancePhaseSchema>

export const dataMaintenanceStatusSchema = z.object({
  phase: dataMaintenancePhaseSchema,
  processed: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().optional(),
  lastError: z.string().optional(),
})
export type DataMaintenanceStatus = z.infer<typeof dataMaintenanceStatusSchema>

export const internalSessionHistoryListRequestSchema = z.object({
  workspacePath: z.string().min(1),
  query: z.string().default(''),
})
export type InternalSessionHistoryListRequest = z.infer<typeof internalSessionHistoryListRequestSchema>

export const internalSessionHistoryListResponseSchema = z.object({
  entries: z.array(sessionHistoryEntrySchema),
  total: z.number().int().nonnegative(),
  maintenance: dataMaintenanceStatusSchema,
})
export type InternalSessionHistoryListResponse = z.infer<typeof internalSessionHistoryListResponseSchema>

export const internalSessionHistoryHideRequestSchema = z.object({
  entryId: z.string().min(1),
  provider: providerSchema,
  sessionId: z.string().optional(),
})
export type InternalSessionHistoryHideRequest = z.infer<typeof internalSessionHistoryHideRequestSchema>

export const archiveRecallHiddenReasonSchema = z.enum(['compact'])
export type ArchiveRecallHiddenReason = z.infer<typeof archiveRecallHiddenReasonSchema>

export const archiveRecallSnapshotSchema = z.object({
  hiddenReason: archiveRecallHiddenReasonSchema,
  hiddenMessageCount: z.number().int().nonnegative(),
  messages: z.array(chatMessageSchema).default([]),
})
export type ArchiveRecallSnapshot = z.infer<typeof archiveRecallSnapshotSchema>

export const compactedCardHistoryLoadRequestSchema = z.object({
  cardId: z.string().min(1),
})
export type CompactedCardHistoryLoadRequest = z.infer<typeof compactedCardHistoryLoadRequestSchema>

export const compactedCardHistoryLoadResponseSchema = z.object({
  snapshot: archiveRecallSnapshotSchema.nullable(),
})
export type CompactedCardHistoryLoadResponse = z.infer<typeof compactedCardHistoryLoadResponseSchema>

// ── External history import ──────────────────────────────────────────────────

export const externalSessionSummarySchema = z.object({
  id: z.string().min(1),
  provider: providerSchema,
  title: z.string().min(1),
  model: z.string().default(''),
  workspacePath: z.string().min(1),
  messageCount: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type ExternalSessionSummary = z.infer<typeof externalSessionSummarySchema>

export const externalHistoryListRequestSchema = z.object({
  workspacePath: z.string().min(1),
})
export type ExternalHistoryListRequest = z.infer<typeof externalHistoryListRequestSchema>

export const externalHistoryListResponseSchema = z.object({
  sessions: z.array(externalSessionSummarySchema),
})
export type ExternalHistoryListResponse = z.infer<typeof externalHistoryListResponseSchema>

export const externalSessionLoadRequestSchema = z.object({
  provider: providerSchema,
  sessionId: z.string().min(1),
  workspacePath: z.string().min(1),
})
export type ExternalSessionLoadRequest = z.infer<typeof externalSessionLoadRequestSchema>

export const externalSessionLoadResponseSchema = z.object({
  entry: sessionHistoryEntrySchema,
})
export type ExternalSessionLoadResponse = z.infer<typeof externalSessionLoadResponseSchema>

// ── Weather ambient ─────────────────────────────────────────────────────────

export const weatherConditionSchema = z.enum([
  'sunny',
  'partly-cloudy',
  'cloudy',
  'overcast',
  'rainy',
  'drizzle',
  'thunderstorm',
  'snowy',
  'foggy',
  'windy',
  'clear-night',
])
export type WeatherCondition = z.infer<typeof weatherConditionSchema>

export const weatherDataSchema = z.object({
  condition: weatherConditionSchema,
  city: z.string(),
  temperature: z.number(),
  isDay: z.boolean(),
  fetchedAt: z.string().datetime(),
})
export type WeatherData = z.infer<typeof weatherDataSchema>

// ── App settings ─────────────────────────────────────────────────────────────

export const defaultAutoUrgeProfileId = 'auto-urge-default'
export const defaultAutoUrgeProfileName = '默认鞭策'
export const defaultAutoUrgeMessage =
  '你必须百分百验证通过你要解决的问题，才能结束回答，如果确定解决了，回复YES，否则不准停下来'
export const defaultAutoUrgeSuccessKeyword = 'YES'

export const autoUrgeJudgeModes = ['keyword', 'local-model'] as const
export const autoUrgeJudgeModeSchema = z.enum(autoUrgeJudgeModes)
export type AutoUrgeJudgeMode = z.infer<typeof autoUrgeJudgeModeSchema>

export const autoUrgeProfileSchema = z.object({
  id: z.string().default(defaultAutoUrgeProfileId),
  name: z.string().default(defaultAutoUrgeProfileName),
  message: z.string().default(defaultAutoUrgeMessage),
  successKeyword: z.string().default(defaultAutoUrgeSuccessKeyword),
  judgeMode: autoUrgeJudgeModeSchema.default('keyword'),
  judgeModel: z.string().default(''),
})
export type AutoUrgeProfile = z.infer<typeof autoUrgeProfileSchema>

// ── Local Ollama integration ─────────────────────────────────────────────────

export const ollamaTaskSchema = z.object({
  state: z.enum(['idle', 'running', 'success', 'error']),
  kind: z.enum(['install-ollama', 'start-service', 'pull-model']).optional(),
  model: z.string().optional(),
  logs: z
    .array(
      z.object({
        createdAt: z.string(),
        level: z.enum(['info', 'error']),
        message: z.string(),
      }),
    )
    .default([]),
})
export type OllamaTask = z.infer<typeof ollamaTaskSchema>

export const ollamaStatusSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  version: z.string().default(''),
  models: z
    .array(
      z.object({
        name: z.string(),
        sizeBytes: z.number().optional(),
      }),
    )
    .default([]),
  recommendedModel: z.object({
    name: z.string(),
    totalMemoryGb: z.number(),
  }),
  task: ollamaTaskSchema,
})
export type OllamaStatus = z.infer<typeof ollamaStatusSchema>

export const ollamaPullRequestSchema = z.object({
  model: z.string().trim().min(1),
})
export type OllamaPullRequest = z.infer<typeof ollamaPullRequestSchema>

export const ollamaJudgeRequestSchema = z.object({
  model: z.string().trim().min(1),
  text: z.string(),
})
export type OllamaJudgeRequest = z.infer<typeof ollamaJudgeRequestSchema>

export const ollamaJudgeResponseSchema = z.object({
  ok: z.boolean(),
  shouldContinue: z.boolean().optional(),
  error: z.string().optional(),
})
export type OllamaJudgeResponse = z.infer<typeof ollamaJudgeResponseSchema>

export const editorSettingsSchema = z.object({
  fontSize: z.number().finite().min(10).max(24).default(13),
  wordWrap: z.boolean().default(false),
  minimap: z.boolean().default(false),
  tabSize: z.union([z.literal(2), z.literal(4)]).default(2),
})
export type EditorSettings = z.infer<typeof editorSettingsSchema>

export const codexPersonalitySettingSchema = z.enum(['default', 'none', 'friendly', 'pragmatic'])
export type CodexPersonalitySetting = z.infer<typeof codexPersonalitySettingSchema>

export const codexPersonalitySchema = z.enum(['none', 'friendly', 'pragmatic'])
export type CodexPersonality = z.infer<typeof codexPersonalitySchema>

export const appSettingsSchema = z.object({
  language: appLanguageSchema.default('zh-CN'),
  theme: themeSchema.default('dark'),
  customThemeBase: customThemeBaseSchema.catch('dark').default('dark'),
  customBaseColor: z.string().nullable().catch(null).default(null),
  accentColor: z.string().nullable().catch(null).default(null),
  activeTopTab: topTabNameSchema.default('ambience'),
  editor: editorSettingsSchema.default({ fontSize: 13, wordWrap: false, minimap: false, tabSize: 2 }),
  uiScale: z.number().finite().default(1),
  fontFamily: fontFamilySchema.default('default'),
  fontScale: z.number().finite().default(1),
  lineHeightScale: z.number().finite().default(1),
  resilientProxyEnabled: z.boolean().default(true),
  cliRoutingEnabled: z.boolean().default(true),
  resilientProxyStallTimeoutSec: z.number().finite().min(10).max(300).default(60),
  resilientProxyMaxRetries: z.number().int().min(-1).max(50).default(6),
  resilientProxyFirstByteTimeoutSec: z.number().finite().min(30).max(600).default(90),
  musicAlbumCoverEnabled: z.boolean().default(false),
  gitCardEnabled: z.boolean().default(true),
  fileTreeCardEnabled: z.boolean().default(true),
  stickyNoteCardEnabled: z.boolean().default(true),
  automationBoardCardEnabled: z.boolean().default(false),
  pmCardEnabled: z.boolean().default(true),
  brainstormCardEnabled: z.boolean().default(false),
  experimentalMusicEnabled: z.boolean().default(false),
  experimentalWhiteNoiseEnabled: z.boolean().default(false),
  experimentalWeatherEnabled: z.boolean().default(false),
  agentDoneSoundEnabled: z.boolean().default(false),
  agentDoneSoundVolume: z.number().min(0).max(1).default(0.7),
  allAgentsDoneSoundEnabled: z.boolean().default(false),
  allAgentsDoneSoundVolume: z.number().min(0).max(1).default(0.7),
  crossProviderSkillReuseEnabled: z.boolean().default(true),
  accessibilitySupportEnabled: z.boolean().default(false),
  minimizeToTaskbarOnCloseEnabled: z.boolean().default(false),
  autoUrgeEnabled: z.boolean().default(false),
  autoUrgeProfiles: z.array(autoUrgeProfileSchema).default([
    {
      id: defaultAutoUrgeProfileId,
      name: defaultAutoUrgeProfileName,
      message: defaultAutoUrgeMessage,
      successKeyword: defaultAutoUrgeSuccessKeyword,
      judgeMode: 'keyword' as const,
      judgeModel: '',
    },
  ]),
  autoUrgeActiveProfileId: z.string().default(defaultAutoUrgeProfileId),
  autoUrgeMessage: z.string().default(defaultAutoUrgeMessage),
  autoUrgeSuccessKeyword: z.string().default(defaultAutoUrgeSuccessKeyword),
  autoUrgeGlobalControlEnabled: z.boolean().default(false),
  autoUrgeGlobalActive: z.boolean().default(false),
  autoUrgeGlobalProfileId: z.string().default(defaultAutoUrgeProfileId),
  repeatLoopEnabled: z.boolean().default(false),
  wakeTimerEnabled: z.boolean().default(true),
  // 新会话的唤醒方式种子：用户上次选的条件/时长。只喂新 Tab，不回溯改写已开的卡，
  // 与默认模型的 per-card 语义一致（AGENTS.md pitfall #40）。
  wakeTimerDefaultMode: wakeTimerModeSchema.default('workspace-agents'),
  wakeTimerDefaultDurationMinutes: z
    .number()
    .finite()
    .min(minWakeTimerDurationMinutes)
    .max(maxWakeTimerDurationMinutes)
    .default(defaultWakeTimerDurationMinutes),
  weatherCity: z.string().default(''),
  systemPrompt: z.string().default(defaultSystemPrompt),
  modelPromptRules: z.array(modelPromptRuleSchema).default([]),
  codexPersonality: codexPersonalitySettingSchema.default('default'),
  codexFastMode: z.boolean().default(false),
  agentOutsideWorkspaceWriteEnabled: z.boolean().default(true),
  codexDestructiveCommandProtectionEnabled: z.boolean().default(true),
  codexIsolatedHomeEnabled: z.boolean().default(true),
  requestModels: requestModelSettingsSchema.default({
    codex: DEFAULT_CODEX_MODEL,
    claude: DEFAULT_CLAUDE_MODEL,
  }),
  modelReasoningEfforts: modelReasoningEffortsSchema.default({
    codex: {},
    claude: {},
  }),
  providerProfiles: providerProfilesSchema.default({
    codex: {
      activeProfileId: '',
      profiles: [],
    },
    claude: {
      activeProfileId: '',
      profiles: [],
    },
  }),
  gitAgentModel: z.string().default(DEFAULT_GIT_AGENT_MODEL),
  lastModel: z.object({
    provider: providerSchema,
    model: z.string(),
  }).optional(),
  recentWorkspaces: z.array(recentWorkspaceSchema).default([]),
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export const stickyNoteViewStateSchema = z.object({
  scrollTop: z.number().nonnegative().default(0),
  selectionStart: z.number().int().nonnegative().default(0),
  selectionEnd: z.number().int().nonnegative().default(0),
})
export type StickyNoteViewState = z.infer<typeof stickyNoteViewStateSchema>

export const stickyNoteArchiveEntrySchema = z.object({
  content: z.string().default(''),
  updatedAt: z.string().datetime(),
  viewState: stickyNoteViewStateSchema.optional(),
})
export type StickyNoteArchiveEntry = z.infer<typeof stickyNoteArchiveEntrySchema>

// 监工的默认需求文本。server 与 client 共用，所以放 schema 而不是 i18n：
// 它是一段会被持久化进用户配置的可编辑数据，不是界面文案。
export const defaultAutomationBoardSupervisorRequirement =
  '检查当前看板每个原始需求，以及 agent 结尾交付情况，自行决定是否进行鞭策还是将其移动到已完成列。'
  + '如果是 agent 正在等子任务，就过段时间再看看情况，如果他超过半小时没下文，就训斥一下他让他接着做。'

export const automationBoardTriggerKinds = ['last-item-settled'] as const
export const automationBoardTriggerKindSchema = z.enum(automationBoardTriggerKinds)
export type AutomationBoardTriggerKind = z.infer<typeof automationBoardTriggerKindSchema>

// 触发器是**模板的一个字段**，不是工作区的全局配置（v1 曾经是）。
// 触发一次 = 自动执行一次"把这个模板拖进目标泳道"，不引入任何新的执行语义。
export const automationBoardTemplateTriggerSchema = z.object({
  enabled: z.boolean().default(false),
  kind: automationBoardTriggerKindSchema.default('last-item-settled'),
  // 触发时实例落到哪条道。默认 running = 立即执行。
  lane: automationBoardLaneSchema.default('running'),
  // 同一个模板两次触发之间的最小间隔，防抖。
  minIntervalMinutes: z.number().finite().min(0).max(24 * 60).default(1),
})
export type AutomationBoardTemplateTrigger = z.infer<typeof automationBoardTemplateTriggerSchema>

export const createDefaultAutomationBoardTemplateTrigger =
  (): AutomationBoardTemplateTrigger => ({
    enabled: false,
    kind: 'last-item-settled',
    lane: 'running',
    minIntervalMinutes: 1,
  })

export const automationBoardTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  requirement: z.string().default(''),
  provider: providerSchema.default('codex'),
  model: z.string().default(''),
  reasoningEffort: z.string().default('max'),
  thinkingEnabled: z.boolean().default(true),
  planMode: z.boolean().default(false),
  // 由本模板实例化出来的卡片是否带超管权限（= 能读写本工作区其他会话）。
  // 内置的"看板监工"模板默认为 true，这就是它全部的"监工性"。
  adminAccess: z.boolean().default(false),
  // 随工作区自动种入的默认模板。用户仍可编辑与删除，只是多一个"恢复默认文案"。
  builtIn: z.boolean().default(false),
  trigger: automationBoardTemplateTriggerSchema.default(
    createDefaultAutomationBoardTemplateTrigger(),
  ),
  // 上一次由本模板触发生成、仍活在看板上的实例卡。复用它是为了让监工保有
  // 跨轮上下文；那张卡被删或被拖出看板后这里就作废，下次触发新建一张。
  instanceCardId: z.string().default(''),
  wakeTimerActive: z.boolean().default(false),
  wakeTimerMode: wakeTimerModeSchema.optional(),
  wakeTimerDurationMinutes: z
    .number()
    .finite()
    .min(minWakeTimerDurationMinutes)
    .max(maxWakeTimerDurationMinutes)
    .optional(),
  repeatLoopActive: z.boolean().default(false),
  repeatLoopRemaining: z.number().int().min(0).optional(),
  createdAt: z.string().datetime().optional(),
})
export type AutomationBoardTemplate = z.infer<typeof automationBoardTemplateSchema>

// 模板的生命周期必须长于看板卡片本身（删掉看板 tab 不能丢），所以按
// workspacePath 挂在 AppState 上，与既有 stickyNoteArchive 同构。
export const automationBoardWorkspaceStateSchema = z.object({
  templates: z.array(automationBoardTemplateSchema).default([]),
  /**
   * 看板本身的编排（项 / 泳道宽度 / composer 参数），与模板同级存活。
   *
   * 症状：关掉看板 tab（含右键「关闭其他标签页」这种顺手误伤），整块看板零痕迹
   *   消失 —— 看板卡没有消息，`archiveCardToHistory` 直接返回 null，连一条会话
   *   归档都不留；而项对应的 agent 卡片因为刻意不在 `pane.tabs` 里，就地变成
   *   看不见也删不掉的孤儿（2026-08-13 用户机器现场：10 张孤儿卡 + 0 张看板卡）。
   * 根因：v2 只把**模板**提到了工作区级，items 仍然只挂在卡片上，FR6 立的规矩
   *   "生命周期长于看板卡片"只兑现了一半。
   * 被否决：在 closeTab 里给看板卡加确认弹窗。那既拦不住 moveTab / 换模型 /
   *   崩溃恢复这些同样会带走卡片的路径，也没解决存量孤儿。
   *
   * 卡片上的 `card.automationBoard` 仍是渲染入口，这里是它的持久层真相，
   * 由 reducer 出口的 `mirrorAutomationBoardsToWorkspaces` 单点同步。
   */
  board: automationBoardSchema.optional(),
})
export type AutomationBoardWorkspaceState = z.infer<typeof automationBoardWorkspaceStateSchema>

// v1 的工作区级自动触发配置。已被 template.trigger 取代，这里只保留一个
// **宽松的**解析形状供 state-store 的一次性迁移读取旧存档，绝不再写入。
export const legacyAutomationBoardAutoTriggerSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: providerSchema.optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    requirement: z.string().optional(),
    minIntervalMinutes: z.number().finite().optional(),
  })
  .passthrough()
export type LegacyAutomationBoardAutoTrigger = z.infer<
  typeof legacyAutomationBoardAutoTriggerSchema
>

export const stickyNoteRequestSchema = z.object({
  workspacePath: z.string().min(1),
  noteId: z.string().min(1),
})
export type StickyNoteRequest = z.infer<typeof stickyNoteRequestSchema>

export const stickyNoteListRequestSchema = z.object({
  workspacePath: z.string().min(1),
})
export type StickyNoteListRequest = z.infer<typeof stickyNoteListRequestSchema>

export const stickyNoteSearchRequestSchema = stickyNoteListRequestSchema.extend({
  query: z.string().max(200).default(''),
})
export type StickyNoteSearchRequest = z.infer<typeof stickyNoteSearchRequestSchema>

export const stickyNoteAttachmentsSchema = z.array(imageAttachmentSchema).max(50).default([])
export type StickyNoteAttachments = z.infer<typeof stickyNoteAttachmentsSchema>

export const stickyNoteSaveRequestSchema = stickyNoteRequestSchema.extend({
  title: z.string(),
  content: z.string().max(64_000),
  attachments: stickyNoteAttachmentsSchema,
  checkpoint: z.boolean().default(false),
})
export type StickyNoteSaveRequest = z.infer<typeof stickyNoteSaveRequestSchema>

export const stickyNoteVersionRequestSchema = stickyNoteRequestSchema.extend({
  versionId: z.string().min(1),
})
export type StickyNoteVersionRequest = z.infer<typeof stickyNoteVersionRequestSchema>

export const stickyNoteVersionSummarySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  title: z.string(),
  preview: z.string(),
})
export type StickyNoteVersionSummary = z.infer<typeof stickyNoteVersionSummarySchema>

export const stickyNoteSummarySchema = z.object({
  noteId: z.string().min(1),
  title: z.string(),
  fileName: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  preview: z.string(),
})
export type StickyNoteSummary = z.infer<typeof stickyNoteSummarySchema>

export const stickyNoteListResponseSchema = z.object({
  notes: z.array(stickyNoteSummarySchema).default([]),
})
export type StickyNoteListResponse = z.infer<typeof stickyNoteListResponseSchema>

export const stickyNoteDocumentSchema = stickyNoteSummarySchema.extend({
  content: z.string(),
  attachments: stickyNoteAttachmentsSchema,
  versions: z.array(stickyNoteVersionSummarySchema).default([]),
})
export type StickyNoteDocument = z.infer<typeof stickyNoteDocumentSchema>

export const stickyNoteVersionDocumentSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  title: z.string(),
  content: z.string(),
  attachments: stickyNoteAttachmentsSchema,
})
export type StickyNoteVersionDocument = z.infer<typeof stickyNoteVersionDocumentSchema>

export const appStateSchema = z.object({
  version: z.literal(1),
  settings: appSettingsSchema.default({
    language: 'zh-CN',
    theme: 'dark',
    customThemeBase: 'dark',
    customBaseColor: null,
    accentColor: null,
    activeTopTab: 'ambience',
    editor: { fontSize: 13, wordWrap: false, minimap: false, tabSize: 2 },
    uiScale: 1,
    fontFamily: 'default',
    fontScale: 1,
    lineHeightScale: 1,
    resilientProxyEnabled: true,
    cliRoutingEnabled: true,
    resilientProxyStallTimeoutSec: 60,
    resilientProxyMaxRetries: 6,
    resilientProxyFirstByteTimeoutSec: 90,
    musicAlbumCoverEnabled: false,
    gitCardEnabled: true,
    fileTreeCardEnabled: true,
    stickyNoteCardEnabled: true,
    automationBoardCardEnabled: false,
    pmCardEnabled: true,
    brainstormCardEnabled: false,
    experimentalMusicEnabled: false,
    experimentalWhiteNoiseEnabled: false,
    experimentalWeatherEnabled: false,
    agentDoneSoundEnabled: false,
    agentDoneSoundVolume: 0.7,
    allAgentsDoneSoundEnabled: false,
    allAgentsDoneSoundVolume: 0.7,
    crossProviderSkillReuseEnabled: true,
    accessibilitySupportEnabled: false,
    minimizeToTaskbarOnCloseEnabled: false,
    autoUrgeEnabled: false,
    autoUrgeProfiles: [
      {
        id: defaultAutoUrgeProfileId,
        name: defaultAutoUrgeProfileName,
        message: defaultAutoUrgeMessage,
        successKeyword: defaultAutoUrgeSuccessKeyword,
        judgeMode: 'keyword' as const,
        judgeModel: '',
      },
    ],
    autoUrgeActiveProfileId: defaultAutoUrgeProfileId,
    autoUrgeMessage: defaultAutoUrgeMessage,
    autoUrgeSuccessKeyword: defaultAutoUrgeSuccessKeyword,
    autoUrgeGlobalControlEnabled: false,
    autoUrgeGlobalActive: false,
    autoUrgeGlobalProfileId: defaultAutoUrgeProfileId,
    repeatLoopEnabled: false,
    wakeTimerEnabled: true,
    wakeTimerDefaultMode: 'workspace-agents' as const,
    wakeTimerDefaultDurationMinutes: defaultWakeTimerDurationMinutes,
    weatherCity: '',
    systemPrompt: defaultSystemPrompt,
    modelPromptRules: [],
    codexPersonality: 'default',
    codexFastMode: false,
    agentOutsideWorkspaceWriteEnabled: true,
    codexDestructiveCommandProtectionEnabled: true,
    codexIsolatedHomeEnabled: true,
    requestModels: {
      codex: DEFAULT_CODEX_MODEL,
      claude: DEFAULT_CLAUDE_MODEL,
    },
    modelReasoningEfforts: {
      codex: {},
      claude: {},
    },
    providerProfiles: {
      codex: {
        activeProfileId: '',
        profiles: [],
      },
      claude: {
        activeProfileId: '',
        profiles: [],
      },
    },
    gitAgentModel: DEFAULT_GIT_AGENT_MODEL,
    recentWorkspaces: [],
  }),
  columns: z.array(boardColumnSchema),
  sessionHistory: z.array(sessionHistoryEntrySchema).default([]),
  stickyNoteArchive: z.record(z.string(), stickyNoteArchiveEntrySchema).default({}),
  // Keyed by workspacePath, like stickyNoteArchive above.
  automationBoards: z.record(z.string(), automationBoardWorkspaceStateSchema).default({}),
  updatedAt: z.string().datetime(),
})
export type AppState = z.infer<typeof appStateSchema>

export const stateRecoveryIssueKindSchema = z.enum(['corrupted-wal', 'newer-temp-state'])
export type StateRecoveryIssueKind = z.infer<typeof stateRecoveryIssueKindSchema>

export const stateRecoveryOptionSourceSchema = z.enum(['current-state', 'snapshot', 'temp-state'])
export type StateRecoveryOptionSource = z.infer<typeof stateRecoveryOptionSourceSchema>

export const stateRecoveryIssueSchema = z.object({
  kind: stateRecoveryIssueKindSchema,
  fileName: z.string().min(1),
  updatedAt: z.string().datetime().optional(),
  details: z.string().default(''),
})
export type StateRecoveryIssue = z.infer<typeof stateRecoveryIssueSchema>

export const stateRecoveryOptionSchema = z.object({
  id: z.string().min(1),
  source: stateRecoveryOptionSourceSchema,
  fileName: z.string().min(1),
  updatedAt: z.string().datetime().optional(),
  recommended: z.boolean().default(false),
})
export type StateRecoveryOption = z.infer<typeof stateRecoveryOptionSchema>

export const startupStateRecoverySchema = z.object({
  issues: z.array(stateRecoveryIssueSchema).min(1),
  options: z.array(stateRecoveryOptionSchema).min(1),
  currentOptionId: z.string().min(1),
})
export type StartupStateRecovery = z.infer<typeof startupStateRecoverySchema>

export const desktopRuntimeKindSchema = z.enum(['dev', 'release'])
export type DesktopRuntimeKind = z.infer<typeof desktopRuntimeKindSchema>

export const recentCrashRecoverySchema = z.object({
  crashedAt: z.string().datetime(),
  errorSummary: z.string().default(''),
  sessionHistoryEntryIds: z.array(z.string().min(1)).default([]),
  runtimeKind: desktopRuntimeKindSchema.optional(),
})
export type RecentCrashRecovery = z.infer<typeof recentCrashRecoverySchema>

export const interruptedSessionResumeModeSchema = z.enum(['resume', 'retry-last-user-message'])
export type InterruptedSessionResumeMode = z.infer<typeof interruptedSessionResumeModeSchema>

export const interruptedSessionEntrySchema = z.object({
  columnId: z.string().min(1),
  cardId: z.string().min(1),
  title: z.string().default(''),
  provider: providerSchema,
  sessionId: z.string().optional(),
  sessionModel: z.string().optional(),
  recoverable: z.boolean().default(false),
  resumeMode: interruptedSessionResumeModeSchema.default('resume'),
  resumePrompt: z.string().default(''),
  resumeAttachments: z.array(imageAttachmentSchema).default([]),
})
export type InterruptedSessionEntry = z.infer<typeof interruptedSessionEntrySchema>

export const interruptedSessionRecoverySchema = z.object({
  entries: z.array(interruptedSessionEntrySchema).min(1),
})
export type InterruptedSessionRecovery = z.infer<typeof interruptedSessionRecoverySchema>

export const appStateRecoverySchema = z.object({
  startup: startupStateRecoverySchema.nullable().default(null),
  recentCrash: recentCrashRecoverySchema.nullable().default(null),
  interruptedSessions: interruptedSessionRecoverySchema.nullable().default(null),
})
export type AppStateRecovery = z.infer<typeof appStateRecoverySchema>

export const appStateLoadResponseSchema = z.object({
  state: appStateSchema,
  recovery: appStateRecoverySchema.default({
    startup: null,
    recentCrash: null,
    interruptedSessions: null,
  }),
})
export type AppStateLoadResponse = z.infer<typeof appStateLoadResponseSchema>

export const stateRecoverySelectionSchema = z.object({
  optionId: z.string().min(1),
})
export type StateRecoverySelection = z.infer<typeof stateRecoverySelectionSchema>

export const rendererCrashSourceSchema = z.enum(['window-error', 'unhandled-rejection', 'react-boundary'])
export type RendererCrashSource = z.infer<typeof rendererCrashSourceSchema>

export const rendererCrashCaptureRequestSchema = z.object({
  source: rendererCrashSourceSchema,
  message: z.string().min(1),
  stack: z.string().default(''),
  state: appStateSchema,
})
export type RendererCrashCaptureRequest = z.infer<typeof rendererCrashCaptureRequestSchema>

export const providerStatusSchema = z.object({
  provider: providerSchema,
  available: z.boolean(),
  command: z.string().optional(),
  note: z.string().optional(),
})
export type ProviderStatus = z.infer<typeof providerStatusSchema>

export const setupLogSchema = z.object({
  createdAt: z.string().datetime(),
  level: z.enum(['info', 'error']).default('info'),
  message: z.string(),
})
export type SetupLog = z.infer<typeof setupLogSchema>

export const setupStatusSchema = z.object({
  state: z.enum(['idle', 'running', 'success', 'error', 'unsupported']),
  message: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  logs: z.array(setupLogSchema).default([]),
})
export type SetupStatus = z.infer<typeof setupStatusSchema>

export const setupRunRequestSchema = z.object({
  mode: z.enum(['install-missing', 'update-cli']).default('install-missing'),
  cli: z.enum(['all', 'claude', 'codex']).default('all'),
  version: z.string().default('latest'),
})
export type SetupRunRequestInput = z.input<typeof setupRunRequestSchema>
export type SetupRunRequest = z.infer<typeof setupRunRequestSchema>

export const environmentCheckIdSchema = z.enum(['git', 'node', 'claude', 'codex'])
export type EnvironmentCheckId = z.infer<typeof environmentCheckIdSchema>

export const environmentCheckSchema = z.object({
  id: environmentCheckIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
})
export type EnvironmentCheck = z.infer<typeof environmentCheckSchema>

export const onboardingStatusSchema = z.object({
  environment: z.object({
    ready: z.boolean(),
    checks: z.array(environmentCheckSchema).default([]),
  }),
  ccSwitch: z.object({
    available: z.boolean(),
    source: z.string().min(1).optional(),
  }),
})
export type OnboardingStatus = z.infer<typeof onboardingStatusSchema>

export const codexSandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access'])
export type CodexSandboxMode = z.infer<typeof codexSandboxModeSchema>

export const chatRequestSchema = z.object({
  provider: providerSchema,
  workspacePath: z.string().min(1),
  model: z.string().optional().default(''),
  reasoningEffort: z.string().default('max'),
  thinkingEnabled: z.boolean().default(true),
  planMode: z.boolean().default(false),
  streamId: z.string().min(1).optional(),
  sessionId: z.string().optional(),
  // Card identity lets the Claude keepalive pool key long-lived CLI processes
  // and route unsolicited turns (background-task wake-ups) back to the card.
  cardId: z.string().min(1).optional(),
  language: appLanguageSchema.default('zh-CN'),
  systemPrompt: z.string().default(defaultSystemPrompt),
  modelPromptRules: z.array(modelPromptRuleSchema).default([]),
  crossProviderSkillReuseEnabled: z.boolean().default(true),
  prompt: z.string().default(''),
  attachments: z.array(imageAttachmentSchema).default([]),
  archiveRecall: archiveRecallSnapshotSchema.optional(),
  sandboxMode: codexSandboxModeSchema.optional(),
  approvalPolicy: codexApprovalPolicySchema.optional(),
  networkAccessEnabled: z.boolean().optional(),
  agentOutsideWorkspaceWriteEnabled: z.boolean().default(true),
  codexDestructiveCommandProtectionEnabled: z.boolean().default(true),
  codexIsolatedHomeEnabled: z.boolean().default(true),
  personality: codexPersonalitySchema.optional(),
  serviceTier: z.literal('priority').optional(),
  // 这一回合带超管权限（card.adminAccess === true），是唯一会把工作区 MCP
  // 接进 provider 启动的回合。`selfCardId` 让 MCP 侧把请求方自己从会话清单里
  // 滤掉 —— 否则模型会把自己列出来再给自己发消息。
  adminAccess: z
    .object({
      columnId: z.string().min(1),
      selfCardId: z.string().min(1),
    })
    .optional(),
}).refine((value) => {
  const hasPrompt = value.prompt.trim().length > 0
  const hasAttachments = value.attachments.length > 0
  const hasResumeSession = typeof value.sessionId === 'string' && value.sessionId.trim().length > 0

  return hasPrompt || hasAttachments || hasResumeSession
}, {
  message: 'A prompt or image attachment is required.',
})
type ParsedChatRequest = z.infer<typeof chatRequestSchema>
export type ChatRequest = Omit<
  ParsedChatRequest,
  | 'agentOutsideWorkspaceWriteEnabled'
  | 'codexDestructiveCommandProtectionEnabled'
  | 'codexIsolatedHomeEnabled'
> & Partial<
  Pick<
    ParsedChatRequest,
    | 'agentOutsideWorkspaceWriteEnabled'
    | 'codexDestructiveCommandProtectionEnabled'
    | 'codexIsolatedHomeEnabled'
  >
>

// 手机远程监工的写命令：由手机页面 POST 到主进程的监工服务，再转发进渲染
// 进程复用电脑端同一条 handler 路径执行（渲染进程是 board state 唯一主人）。
export const remoteMonitorCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send-message'),
    cardId: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal('stop-stream'),
    cardId: z.string().min(1),
  }),
  z.object({
    type: z.literal('add-tab'),
    columnId: z.string().min(1),
  }),
  z.object({
    type: z.literal('set-card-model'),
    cardId: z.string().min(1),
    provider: providerSchema,
    // 空串 = "跟随 provider 默认模型"，与电脑端选择器的第一个选项一致。
    model: z.string(),
  }),
  z.object({
    type: z.literal('set-card-reasoning-effort'),
    cardId: z.string().min(1),
    reasoningEffort: z.string().min(1),
  }),
])
export type RemoteMonitorCommand = z.infer<typeof remoteMonitorCommandSchema>

// 超管权限 MCP 的写命令。与手机监工同一条规矩：桥接服务自身绝不改 state，
// 命令一律转发进渲染进程复用电脑端 handler（"移到某道"因此自动带上正确的
// 中断/执行语义，而不是绕过 resolveAutomationBoardTransition 自己实现一遍）。
//
// 命令只带 `columnId` 而不带 `boardCardId`：目标看板由渲染端解析（该卡已在
// 某个看板里就用那个，否则用本列第一张看板卡），因为"哪张看板"是 state 的
// 事实，模型不该也无法知道。
// 新建会话只能落在这两道里。`done` 被刻意排除：一张刚建出来、一句话没说的卡
// 不可能"已交付"，而超管看不到 UI，只能靠返回文本理解发生了什么 —— 静默把
// `done` 降级成 `standby` 会让它带着错误的世界模型继续决策，所以宁可报错。
export const workspaceAdminCreatableLanes = ['standby', 'running'] as const
export const workspaceAdminCreatableLaneSchema = z.enum(workspaceAdminCreatableLanes)

export const workspaceAdminCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('admin-move-session-to-lane'),
    columnId: z.string().min(1),
    cardId: z.string().min(1),
    lane: automationBoardLaneSchema,
  }),
  z.object({
    type: z.literal('admin-send-session-message'),
    columnId: z.string().min(1),
    cardId: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('admin-set-session-wake-timer'),
    columnId: z.string().min(1),
    cardId: z.string().min(1),
    mode: wakeTimerModeSchema,
    durationMinutes: z
      .number()
      .finite()
      .min(minWakeTimerDurationMinutes)
      .max(maxWakeTimerDurationMinutes)
      .optional(),
  }),
  // 唯一一条目标卡还不存在的命令，因此没有 `cardId`。落位同样由渲染端解析：
  // 本列有看板就建成看板项，没有就建成普通 tab 会话 —— 空工作区（一张卡都没有，
  // 因此也没有看板卡）正是这个工具存在的理由，那种情况下失败就等于没做。
  //
  // 刻意不带 `adminAccess`：超管权限一旦能由超管自己授予就会自我复制，
  // 而用户在界面上只授权过一次。授予点必须留在用户手里。
  z.object({
    type: z.literal('admin-create-session'),
    columnId: z.string().min(1),
    requirement: z.string().min(1),
    lane: workspaceAdminCreatableLaneSchema,
    provider: providerSchema.optional(),
    model: z.string().min(1).optional(),
  }),
])
export type WorkspaceAdminCommand = z.infer<typeof workspaceAdminCommandSchema>

// 渲染进程主动推给主进程的实时工作区镜像。读盘快照在流式期间被刻意节流
// （pitfall 54/114），对超管会话太旧；这份镜像极小且有界，几 KB 级。
//
// 作用域是**一整个工作区列**，不只是某张看板：超管权限的语义是"操作其他
// 会话"，普通 tab 里的会话同样在内。
export const workspaceSessionMirrorItemSchema = z.object({
  cardId: z.string().min(1),
  title: z.string().default(''),
  provider: z.string().default(''),
  model: z.string().default(''),
  status: z.string().default('idle'),
  backgroundWorkPending: z.boolean().default(false),
  // 这张卡在某张看板里的位置。普通 tab 会话没有这一段。
  board: z
    .object({
      boardCardId: z.string().min(1),
      lane: automationBoardLaneSchema,
      requirement: z.string().default(''),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    })
    .optional(),
  // 是否作为一个真正的 pane tab 展现。与 board 互斥（一张卡只可能是其中之一）。
  isTab: z.boolean().default(false),
  wakeTimerActive: z.boolean().default(false),
  wakeTimerWakeAt: z.string().optional(),
  repeatLoopActive: z.boolean().default(false),
  // 最后一条消息的 createdAt —— 判断"超过半小时没下文"的依据。
  lastActivityAt: z.string().optional(),
  lastMessagePreview: z.string().default(''),
  messageCount: z.number().int().nonnegative().default(0),
  // 最近若干条转录，供 read_session 直接读。刻意随镜像一起推而不是另开一条
  // 请求/应答通道：载荷有界（条数 × 单条字符都封顶），2 秒级的陈旧无影响。
  recentEntries: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.string().default(''),
        content: z.string().default(''),
        kind: z.string().optional(),
        createdAt: z.string().optional(),
      }),
    )
    .default([]),
})
export type WorkspaceSessionMirrorItem = z.infer<typeof workspaceSessionMirrorItemSchema>

// 镜像的硬预算。发送端（渲染进程）与接收端（server session 的 publish）**各跑
// 一遍**，这样新增一个调用方也无法绕过上限把整段转录送出程序边界（pitfall 183）。
export const workspaceMirrorRequirementMaxChars = 2000
export const workspaceMirrorPreviewMaxChars = 400
export const workspaceMirrorEntryMaxChars = 600
export const workspaceMirrorEntryLimit = 12

export const workspaceSessionMirrorSchema = z.object({
  columnId: z.string().min(1),
  workspacePath: z.string().default(''),
  generatedAt: z.string().datetime(),
  // 本列所有看板容器卡的 id，供 MCP 侧解释"换道会落到哪张看板"。
  boardCardIds: z.array(z.string().min(1)).default([]),
  sessions: z.array(workspaceSessionMirrorItemSchema).default([]),
})
export type WorkspaceSessionMirror = z.infer<typeof workspaceSessionMirrorSchema>

// Lossless conversation fork: ask the backend to copy the provider's native
// session file truncated before the fork-point user message. A null sessionId
// response means "no native fork was possible" and the renderer falls back to
// the seeded-transcript replay path.
export const forkSessionRequestSchema = z.object({
  provider: providerSchema,
  workspacePath: z.string().min(1),
  sessionId: z.string().min(1),
  forkPoint: z.object({
    content: z.string(),
    createdAt: z.string().datetime().optional(),
  }),
})
export type ForkSessionRequest = z.infer<typeof forkSessionRequestSchema>

export const forkSessionResponseSchema = z.object({
  sessionId: z.string().nullable(),
})
export type ForkSessionResponse = z.infer<typeof forkSessionResponseSchema>

// Fact-check before stream recovery auto-resume: ask the provider's native
// on-disk session transcript whether the last turn actually finished. Only
// Claude is supported for now; other providers report 'unknown' (fail-open,
// caller keeps the existing resume behavior).
export const nativeTurnCompletionRequestSchema = z.object({
  provider: providerSchema,
  sessionId: z.string().min(1),
})
export type NativeTurnCompletionRequest = z.infer<typeof nativeTurnCompletionRequestSchema>

export const nativeTurnCompletionResponseSchema = z.object({
  completion: z.enum(['completed', 'incomplete', 'unknown']),
})
export type NativeTurnCompletionResponse = z.infer<typeof nativeTurnCompletionResponseSchema>

export const attachmentUploadRequestSchema = z.object({
  fileName: z.string().min(1).optional(),
  mimeType: imageAttachmentMimeTypeSchema,
  dataBase64: z.string().min(1),
})
export type AttachmentUploadRequest = z.infer<typeof attachmentUploadRequestSchema>

export const ccSwitchImportRequestSchema = z
  .object({
    mode: z.enum(['default', 'upload']),
    fileName: z.string().min(1).optional(),
    dataBase64: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'upload') {
      if (!value.fileName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fileName'],
          message: 'A file name is required when importing an uploaded file.',
        })
      }

      if (!value.dataBase64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dataBase64'],
          message: 'File contents are required when importing an uploaded file.',
        })
      }
    }
  })
export type CcSwitchImportRequest = z.infer<typeof ccSwitchImportRequestSchema>

export const ccSwitchImportProfileSchema = z.object({
  sourceId: z.string().min(1),
  provider: providerSchema,
  name: z.string().default(''),
  apiKey: z.string().default(''),
  baseUrl: z.string().default(''),
  active: z.boolean().default(false),
})
export type CcSwitchImportProfile = z.infer<typeof ccSwitchImportProfileSchema>

export const ccSwitchImportResponseSchema = z.object({
  source: z.string().min(1),
  importedProfiles: z.array(ccSwitchImportProfileSchema).default([]),
})
export type CcSwitchImportResponse = z.infer<typeof ccSwitchImportResponseSchema>

export const slashCommandRequestSchema = z.object({
  provider: providerSchema,
  workspacePath: z.string().min(1),
  language: appLanguageSchema.default('zh-CN'),
  crossProviderSkillReuseEnabled: z.boolean().default(true),
})
export type SlashCommandRequest = z.infer<typeof slashCommandRequestSchema>

export const chatStartResponseSchema = z.object({
  streamId: z.string().min(1),
})
export type ChatStartResponse = z.infer<typeof chatStartResponseSchema>

export const workspaceValidationRequestSchema = z.object({
  path: z.string().min(1),
})

export const workspaceValidationResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
})

export const gitChangeKindSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>

export const gitChangeSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).optional(),
  kind: gitChangeKindSchema,
  stagedStatus: z.string().length(1),
  workingTreeStatus: z.string().length(1),
  staged: z.boolean(),
  conflicted: z.boolean(),
  addedLines: z.number().int().nonnegative().optional(),
  removedLines: z.number().int().nonnegative().optional(),
  patch: z.string().optional(),
})
export type GitChange = z.infer<typeof gitChangeSchema>

export const gitSummarySchema = z.object({
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  conflicted: z.number().int().nonnegative(),
})
export type GitSummary = z.infer<typeof gitSummarySchema>

export const gitCommitSchema = z.object({
  hash: z.string().min(7),
  shortHash: z.string().min(7),
  summary: z.string(),
  description: z.string(),
  authorName: z.string(),
  authoredAt: z.string().datetime({ offset: true }),
})
export type GitCommit = z.infer<typeof gitCommitSchema>

export const gitStatusSchema = z.object({
  workspacePath: z.string().min(1),
  isRepository: z.boolean(),
  repoRoot: z.string().default(''),
  branch: z.string().default(''),
  upstream: z.string().min(1).optional(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  hasConflicts: z.boolean().default(false),
  clean: z.boolean().default(false),
  summary: gitSummarySchema,
  changes: z.array(gitChangeSchema).default([]),
  lastCommit: gitCommitSchema.nullable().optional(),
  description: z.string().default(''),
  note: z.string().optional(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

export const gitStageRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  staged: z.boolean(),
})
export type GitStageRequest = z.infer<typeof gitStageRequestSchema>

export const gitDiscardRequestSchema = z.object({
  workspacePath: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
})
export type GitDiscardRequest = z.infer<typeof gitDiscardRequestSchema>

export const gitCommitRequestSchema = z.object({
  workspacePath: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().default(''),
  paths: z.array(z.string().min(1)).min(1).optional(),
})
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>

export const gitPullRequestSchema = z.object({
  workspacePath: z.string().min(1),
})
export type GitPullRequest = z.infer<typeof gitPullRequestSchema>

export const gitPushRequestSchema = z.object({
  workspacePath: z.string().min(1),
})
export type GitPushRequest = z.infer<typeof gitPushRequestSchema>

export const gitCommitAllRequestSchema = z.object({
  workspacePath: z.string().min(1),
  summary: z.string().min(1),
  description: z.string().default(''),
})
export type GitCommitAllRequest = z.infer<typeof gitCommitAllRequestSchema>

export const gitLogRequestSchema = z.object({
  workspacePath: z.string().min(1),
  limit: z.number().int().positive().default(20),
  skip: z.number().int().nonnegative().default(0),
})
export type GitLogRequest = z.infer<typeof gitLogRequestSchema>

export const gitLogResponseSchema = z.object({
  commits: z.array(gitCommitSchema),
  hasMore: z.boolean(),
})
export type GitLogResponse = z.infer<typeof gitLogResponseSchema>

export const gitCommitDiffRequestSchema = z.object({
  workspacePath: z.string().min(1),
  hash: z.string().min(7),
})
export type GitCommitDiffRequest = z.infer<typeof gitCommitDiffRequestSchema>

export const gitCommitDiffResponseSchema = z.object({
  patch: z.string(),
})
export type GitCommitDiffResponse = z.infer<typeof gitCommitDiffResponseSchema>

export const gitOperationResponseSchema = z.object({
  status: gitStatusSchema,
  message: z.string().optional(),
  blockedFiles: z.array(z.string()).optional(),
})
export type GitOperationResponse = z.infer<typeof gitOperationResponseSchema>

export const gitCommitResponseSchema = z.object({
  status: gitStatusSchema,
  commit: gitCommitSchema,
})
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>

export const streamAssistantMessageSchema = z.object({
  itemId: z.string().min(1),
  content: z.string(),
})
export type StreamAssistantMessage = z.infer<typeof streamAssistantMessageSchema>

export const streamCommandActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('command'),
  status: chatCommandActivityStatusSchema,
  command: z.string(),
  output: z.string(),
  exitCode: z.number().int().nullable(),
})
export type StreamCommandActivity = z.infer<typeof streamCommandActivitySchema>

export const streamReasoningActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('reasoning'),
  // in_progress 是 2026-08-16 放宽的：Claude 的 thinking 此前累积到
  // content_block_stop 才一次性发出，长思考期间界面全程静默。这是**放宽**不是
  // 改写——旧存档里的 reasoning 一律是 completed，仍然合法。
  status: z.enum(['in_progress', 'completed']),
  text: z.string(),
})
export type StreamReasoningActivity = z.infer<typeof streamReasoningActivitySchema>

export const streamToolActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('tool'),
  status: z.literal('completed'),
  toolName: z.string().min(1),
  summary: z.string(),
  toolInput: z.record(z.string(), z.string()).optional(),
})
export type StreamToolActivity = z.infer<typeof streamToolActivitySchema>

export const streamEditedFileSchema = z.object({
  path: z.string().min(1),
  originalPath: z.string().min(1).optional(),
  kind: gitChangeKindSchema,
  addedLines: z.number().int().nonnegative(),
  removedLines: z.number().int().nonnegative(),
  patch: z.string(),
  patchOmittedReason: z.enum([
    'file-too-large',
    'baseline-unavailable',
    'detail-file-limit',
    'patch-budget',
  ]).optional(),
})
export type StreamEditedFile = z.infer<typeof streamEditedFileSchema>

export const streamEditsActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('edits'),
  status: z.literal('completed'),
  files: z.array(streamEditedFileSchema).default([]),
})
export type StreamEditsActivity = z.infer<typeof streamEditsActivitySchema>

export const streamTodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type StreamTodoStatus = z.infer<typeof streamTodoStatusSchema>

export const streamTodoPrioritySchema = z.enum(['low', 'medium', 'high'])
export type StreamTodoPriority = z.infer<typeof streamTodoPrioritySchema>

export const streamTodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  activeForm: z.string().min(1).optional(),
  status: streamTodoStatusSchema,
  priority: streamTodoPrioritySchema.optional(),
})
export type StreamTodoItem = z.infer<typeof streamTodoItemSchema>

export const streamTodoActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('todo'),
  status: z.literal('completed'),
  items: z.array(streamTodoItemSchema).default([]),
})
export type StreamTodoActivity = z.infer<typeof streamTodoActivitySchema>

export const streamCompactionActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('compaction'),
  status: z.literal('completed'),
  trigger: z.enum(['manual', 'auto']).default('auto'),
})
export type StreamCompactionActivity = z.infer<typeof streamCompactionActivitySchema>

export const streamAgentStatusSchema = z.enum([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
])
export type StreamAgentStatus = z.infer<typeof streamAgentStatusSchema>

export const streamAgentToolSchema = z.enum(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent'])
export type StreamAgentTool = z.infer<typeof streamAgentToolSchema>

export const streamAgentToolCallStatusSchema = z.enum(['inProgress', 'completed', 'failed'])
export type StreamAgentToolCallStatus = z.infer<typeof streamAgentToolCallStatusSchema>

export const streamAgentEntrySchema = z.object({
  threadId: z.string().min(1),
  nickname: z.string().optional(),
  role: z.string().optional(),
  path: z.string().optional(),
  status: streamAgentStatusSchema.default('pendingInit'),
  message: z.string().nullable().optional(),
  activity: z.array(z.string()).optional(),
})
export type StreamAgentEntry = z.infer<typeof streamAgentEntrySchema>

export const streamAgentsActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('agents'),
  status: z.literal('completed'),
  view: z.enum(['toolCall', 'status']).optional(),
  tool: streamAgentToolSchema.optional(),
  callStatus: streamAgentToolCallStatusSchema.optional(),
  prompt: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.string().nullable().optional(),
  agents: z.array(streamAgentEntrySchema).default([]),
})
export type StreamAgentsActivity = z.infer<typeof streamAgentsActivitySchema>

export const askUserOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().default(''),
})
export type AskUserOption = z.infer<typeof askUserOptionSchema>

export const askUserQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().default(''),
  multiSelect: z.boolean().default(false),
  options: z.array(askUserOptionSchema).default([]),
})
export type AskUserQuestionItem = z.infer<typeof askUserQuestionItemSchema>

export const streamAskUserActivitySchema = z.object({
  itemId: z.string().min(1),
  kind: z.literal('ask-user'),
  status: z.literal('completed'),
  question: z.string().min(1),
  header: z.string().default(''),
  multiSelect: z.boolean().default(false),
  options: z.array(askUserOptionSchema).default([]),
  questions: z.array(askUserQuestionItemSchema).optional(),
  planFile: z.string().optional(),
  // True when the question came from a native CLI tool call (AskUserQuestion /
  // ExitPlanMode). The headless CLI auto-answers those tools immediately, so
  // the renderer must stop the stream until the user actually answers.
  nativeTool: z.boolean().optional(),
  // True only for ExitPlanMode approval cards. Approving one must also flip the
  // card out of plan mode before the follow-up send; resuming with
  // `--permission-mode plan` would intercept the next ExitPlanMode again.
  planApproval: z.boolean().optional(),
})
export type StreamAskUserActivity = z.infer<typeof streamAskUserActivitySchema>

export const streamActivitySchema = z.union([
  streamCommandActivitySchema,
  streamReasoningActivitySchema,
  streamToolActivitySchema,
  streamEditsActivitySchema,
  streamTodoActivitySchema,
  streamCompactionActivitySchema,
  streamAskUserActivitySchema,
  streamAgentsActivitySchema,
])
export type StreamActivity = z.infer<typeof streamActivitySchema>

export type StreamStatsEvent = {
  event: 'request' | 'disconnect' | 'recovery_success' | 'recovery_fail'
  endpoint: string
  attempt?: number
  errorType?: string
  alreadyRecorded?: boolean
}

export type StreamErrorRecoveryMode = 'reattach-stream' | 'resume-session'

export type StreamErrorEvent = {
  message: string
  hint?: StreamErrorHint
  recoverable?: boolean
  recoveryMode?: StreamErrorRecoveryMode
  transientOnly?: boolean
  sessionId?: string
}

export type StreamCompletion = 'terminal' | 'background-pending'

// 回合"为什么结束"，取值对齐 ACP v1 的 StopReason（schema v1.20.0）。
// 症状 — 分不清「模型自然收尾」「输出被 max_tokens 截断」「模型拒答」「轮次上限」，
//   一族诊断（空 200、幽灵续跑、输出残缺）全靠事后翻日志猜。
// 根因 — Claude 的 result 事件一直带 stop_reason，但它只被读进 providers.ts 的
//   诊断对象写 server.log，从不进事件流、不落盘（2026-08-16 对照 ACP 时发现）。
// 为什么不叫 stopReason — `message.meta.stopReason` 已被 StoppedRunReason
//   （manual / user-interrupt / ask-user-answer，即"用户为什么停"）占用，同名会
//   让两个不同语义在持久化层撞车。
export type ProviderTurnStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

// 上下文占用，字段语义对齐 ACP v1 的 UsageUpdate（used / size）。
// used = 本回合真正占用的上下文 token；size = 该模型的上下文窗口。
// 二者都由 CLI 自己报（Claude result 的 usage + modelUsage[*].contextWindow），
// 不依赖我们维护任何模型窗口表——那种表迟早和上游漂移（见 pitfall #293）。
export type ProviderTurnUsage = {
  used: number
  size?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
}

export type StreamEventMap = {
  session: { sessionId: string }
  delta: { content: string; itemId?: string }
  log: { message: string }
  // 开流即广播的用户需求原文：手机监工靠它把"谁发了什么"实时镜像到
  // 详情页消息流（电脑端渲染器自己维护 user 消息，收到后忽略）。
  user_message: { content: string }
  assistant_message: StreamAssistantMessage
  activity: StreamActivity
  stats: StreamStatsEvent
  // turnStopReason / usage 是纯增量遥测：老渲染端读不到就是 undefined，
  // 既有的 stopped / completion 语义一个字节都没动。
  done: {
    stopped?: boolean
    completion?: StreamCompletion
    turnStopReason?: ProviderTurnStopReason
    usage?: ProviderTurnUsage
  }
  error: StreamErrorEvent
}

// File system API schemas

export const fileListRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().default(''),
})
export type FileListRequest = z.infer<typeof fileListRequestSchema>

export const fileEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
})
export type FileEntry = z.infer<typeof fileEntrySchema>

export const fileListResponseSchema = z.object({
  entries: z.array(fileEntrySchema),
})
export type FileListResponse = z.infer<typeof fileListResponseSchema>

export const fileSearchRequestSchema = z.object({
  workspacePath: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().positive().max(500).default(200),
})
export type FileSearchRequest = z.infer<typeof fileSearchRequestSchema>

export const fileSearchEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  isDirectory: z.boolean(),
})
export type FileSearchEntry = z.infer<typeof fileSearchEntrySchema>

export const fileSearchResponseSchema = z.object({
  entries: z.array(fileSearchEntrySchema),
})
export type FileSearchResponse = z.infer<typeof fileSearchResponseSchema>

export const fileCreateRequestSchema = z.object({
  workspacePath: z.string().min(1),
  parentRelativePath: z.string().default(''),
  name: z.string().min(1),
})
export type FileCreateRequest = z.infer<typeof fileCreateRequestSchema>

export const fileRenameRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
  nextName: z.string().min(1),
})
export type FileRenameRequest = z.infer<typeof fileRenameRequestSchema>

export const fileMoveRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
  destinationParentRelativePath: z.string().default(''),
})
export type FileMoveRequest = z.infer<typeof fileMoveRequestSchema>

export const fileDeleteRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
})
export type FileDeleteRequest = z.infer<typeof fileDeleteRequestSchema>

export const fileReadRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
})
export type FileReadRequest = z.infer<typeof fileReadRequestSchema>

export const fileReadResponseSchema = z.object({
  content: z.string(),
  language: z.string(),
  /** Content fingerprint used for optimistic-lock saves. Absent for binary/oversized reads. */
  revision: z.string().optional(),
  /** File size in bytes, present whenever the file was stat-ed successfully. */
  size: z.number().optional(),
  /** Editable but big enough that the editor should degrade (no folding, no polling). */
  large: z.boolean().optional(),
  /** Over the hard limit — content is omitted and the file must not be edited. */
  tooLarge: z.boolean().optional(),
  /** Binary sniffed (NUL bytes) — content is omitted and the file must not be edited. */
  binary: z.boolean().optional(),
  /** Base64 payload for supported image previews. */
  dataBase64: z.string().optional(),
  /** MIME type for supported image previews. */
  mimeType: z.string().optional(),
  /** Detected text encoding id ('utf8', 'utf8bom', 'utf16le', 'gb18030', ...). Echo it back on writes. */
  encoding: z.string().optional(),
})
export type FileReadResponse = z.infer<typeof fileReadResponseSchema>

export const fileWriteRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
  /**
   * Optimistic lock: when present, the write is rejected if the on-disk content
   * no longer matches this revision. Absent keeps the legacy overwrite behavior.
   */
  expectedRevision: z.string().optional(),
  /** Encoding id from the matching read; content is written back in these bytes. Absent = utf8. */
  encoding: z.string().optional(),
})
export type FileWriteRequest = z.infer<typeof fileWriteRequestSchema>

export const fileWriteResponseSchema = z.object({
  /** Revision of the freshly written content; becomes the client's next expectedRevision. */
  revision: z.string().optional(),
  /** True when the write was rejected because the file changed on disk. */
  conflict: z.boolean().optional(),
})
export type FileWriteResponse = z.infer<typeof fileWriteResponseSchema>

export const gitFilePathRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
})
export type GitFilePathRequest = z.infer<typeof gitFilePathRequestSchema>

export const gitFileHeadStateSchema = z.object({
  isRepository: z.boolean(),
  headContent: z.string().nullable(),
})
export type GitFileHeadStateResponse = z.infer<typeof gitFileHeadStateSchema>

const gitLineDiffRangeSchema = z.object({
  start: z.number(),
  end: z.number(),
})

export const gitFileLineDiffSchema = z.object({
  isRepository: z.boolean(),
  tracked: z.boolean(),
  added: z.array(gitLineDiffRangeSchema),
  modified: z.array(gitLineDiffRangeSchema),
  removed: z.array(z.number()),
})
export type GitFileLineDiffResponse = z.infer<typeof gitFileLineDiffSchema>
