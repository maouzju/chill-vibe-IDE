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

export const chatActivityKindSchema = z.enum(['command', 'reasoning', 'tool', 'edits', 'todo', 'ask-user'])
export type ChatActivityKind = z.infer<typeof chatActivityKindSchema>

export const chatCommandActivityStatusSchema = z.enum(['in_progress', 'completed', 'declined'])
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

export const themeSchema = z.enum(['light', 'dark', 'system'])
export type AppTheme = z.infer<typeof themeSchema>

export const appLanguageSchema = z.enum(['zh-CN', 'en'])
export type AppLanguage = z.infer<typeof appLanguageSchema>

export const topTabNameSchema = z.enum(['ambience', 'routing', 'settings'])
export type TopTabName = z.infer<typeof topTabNameSchema>

export const cardStatusSchema = z.enum(['idle', 'streaming', 'error'])
export type CardStatus = z.infer<typeof cardStatusSchema>

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

export const chatCardSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  sessionId: z.string().optional(),
  providerSessions: z.record(z.string(), z.string()).default({}),
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
  collapsed: z.boolean().default(false),
  unread: z.boolean().default(false),
  draft: z.string().default(''),
  draftAttachments: z.array(imageAttachmentSchema).default([]),
  stickyNote: z.string().default(''),
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
  provider: providerSchema,
  model: z.string().default(''),
  workspacePath: z.string().min(1),
  messages: z.array(chatMessageSchema).default([]),
  messageCount: z.number().int().nonnegative().optional(),
  messagesPreview: z.boolean().optional(),
  archivedAt: z.string().datetime(),
})
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>

export const internalSessionHistoryLoadRequestSchema = z.object({
  entryId: z.string().min(1),
})
export type InternalSessionHistoryLoadRequest = z.infer<typeof internalSessionHistoryLoadRequestSchema>

export const internalSessionHistoryLoadResponseSchema = z.object({
  entry: sessionHistoryEntrySchema,
})
export type InternalSessionHistoryLoadResponse = z.infer<typeof internalSessionHistoryLoadResponseSchema>

export const archiveRecallHiddenReasonSchema = z.enum(['compact'])
export type ArchiveRecallHiddenReason = z.infer<typeof archiveRecallHiddenReasonSchema>

export const archiveRecallSnapshotSchema = z.object({
  hiddenReason: archiveRecallHiddenReasonSchema,
  hiddenMessageCount: z.number().int().nonnegative(),
  messages: z.array(chatMessageSchema).default([]),
})
export type ArchiveRecallSnapshot = z.infer<typeof archiveRecallSnapshotSchema>

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

export const autoUrgeProfileSchema = z.object({
  id: z.string().default(defaultAutoUrgeProfileId),
  name: z.string().default(defaultAutoUrgeProfileName),
  message: z.string().default(defaultAutoUrgeMessage),
  successKeyword: z.string().default(defaultAutoUrgeSuccessKeyword),
})
export type AutoUrgeProfile = z.infer<typeof autoUrgeProfileSchema>

export const appSettingsSchema = z.object({
  language: appLanguageSchema.default('zh-CN'),
  theme: themeSchema.default('dark'),
  activeTopTab: topTabNameSchema.default('ambience'),
  uiScale: z.number().finite().default(1),
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
  pmCardEnabled: z.boolean().default(true),
  brainstormCardEnabled: z.boolean().default(false),
  experimentalMusicEnabled: z.boolean().default(false),
  experimentalWhiteNoiseEnabled: z.boolean().default(false),
  experimentalWeatherEnabled: z.boolean().default(false),
  agentDoneSoundEnabled: z.boolean().default(false),
  agentDoneSoundVolume: z.number().min(0).max(1).default(0.7),
  crossProviderSkillReuseEnabled: z.boolean().default(true),
  autoUrgeEnabled: z.boolean().default(false),
  autoUrgeProfiles: z.array(autoUrgeProfileSchema).default([
    {
      id: defaultAutoUrgeProfileId,
      name: defaultAutoUrgeProfileName,
      message: defaultAutoUrgeMessage,
      successKeyword: defaultAutoUrgeSuccessKeyword,
    },
  ]),
  autoUrgeActiveProfileId: z.string().default(defaultAutoUrgeProfileId),
  autoUrgeMessage: z.string().default(defaultAutoUrgeMessage),
  autoUrgeSuccessKeyword: z.string().default(defaultAutoUrgeSuccessKeyword),
  weatherCity: z.string().default(''),
  systemPrompt: z.string().default(defaultSystemPrompt),
  modelPromptRules: z.array(modelPromptRuleSchema).default([]),
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

export const appStateSchema = z.object({
  version: z.literal(1),
  settings: appSettingsSchema.default({
    language: 'zh-CN',
    theme: 'dark',
    activeTopTab: 'ambience',
    uiScale: 1,
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
    pmCardEnabled: true,
    brainstormCardEnabled: false,
    experimentalMusicEnabled: false,
    experimentalWhiteNoiseEnabled: false,
    experimentalWeatherEnabled: false,
    agentDoneSoundEnabled: false,
    agentDoneSoundVolume: 0.7,
    crossProviderSkillReuseEnabled: true,
    autoUrgeEnabled: false,
    autoUrgeProfiles: [
      {
        id: defaultAutoUrgeProfileId,
        name: defaultAutoUrgeProfileName,
        message: defaultAutoUrgeMessage,
        successKeyword: defaultAutoUrgeSuccessKeyword,
      },
    ],
    autoUrgeActiveProfileId: defaultAutoUrgeProfileId,
    autoUrgeMessage: defaultAutoUrgeMessage,
    autoUrgeSuccessKeyword: defaultAutoUrgeSuccessKeyword,
    weatherCity: '',
    systemPrompt: defaultSystemPrompt,
    modelPromptRules: [],
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
  language: appLanguageSchema.default('zh-CN'),
  systemPrompt: z.string().default(defaultSystemPrompt),
  modelPromptRules: z.array(modelPromptRuleSchema).default([]),
  crossProviderSkillReuseEnabled: z.boolean().default(true),
  prompt: z.string().default(''),
  attachments: z.array(imageAttachmentSchema).default([]),
  archiveRecall: archiveRecallSnapshotSchema.optional(),
  sandboxMode: codexSandboxModeSchema.optional(),
}).refine((value) => {
  const hasPrompt = value.prompt.trim().length > 0
  const hasAttachments = value.attachments.length > 0
  const hasResumeSession = typeof value.sessionId === 'string' && value.sessionId.trim().length > 0

  return hasPrompt || hasAttachments || hasResumeSession
}, {
  message: 'A prompt or image attachment is required.',
})
export type ChatRequest = z.infer<typeof chatRequestSchema>

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
  status: z.literal('completed'),
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
}

export type StreamEventMap = {
  session: { sessionId: string }
  delta: { content: string }
  log: { message: string }
  assistant_message: StreamAssistantMessage
  activity: StreamActivity
  stats: StreamStatsEvent
  done: { stopped?: boolean }
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
})
export type FileReadResponse = z.infer<typeof fileReadResponseSchema>

export const fileWriteRequestSchema = z.object({
  workspacePath: z.string().min(1),
  relativePath: z.string().min(1),
  content: z.string(),
})
export type FileWriteRequest = z.infer<typeof fileWriteRequestSchema>
