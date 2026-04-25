import type { AppLanguage, ChatMessage, Provider, SlashCommandSource } from './schema.js'

export const defaultAppLanguage: AppLanguage = 'zh-CN'

type LocaleText = {
  loadingEyebrow: string
  loadingTitle: string
  loadingDescription: string
  serviceErrorTitle: string
  serviceErrorDescription: string
  retry: string
  reset: string
  openSettings: string
  closeSettings: string
  preferences: string
  settingsTitle: string
  settingsPanelHeading: string
  settingsGroupAppearance: string
  settingsGroupMusic: string
  settingsGroupModels: string
  settingsGroupEnvironment: string
  settingsGroupUtility: string
  settingsGroupExperimental: string
  settingsGroupData: string

  experimentalMusicLabel: string
  experimentalWhiteNoiseLabel: string
  experimentalWeatherLabel: string
  agentDoneSoundLabel: string
  agentDoneSoundVolumeLabel: string
  autoUrgeLabel: string
  autoUrgeTypesLabel: string
  autoUrgeTypeNameLabel: string
  autoUrgeTypeNamePlaceholder: string
  autoUrgeAddType: string
  autoUrgeUseType: string
  autoUrgeCurrentType: string
  autoUrgeRemoveType: string
  autoUrgeRunningStatus: string
  autoUrgeMessageLabel: string
  autoUrgeMessagePlaceholder: string
  autoUrgeSuccessKeywordLabel: string
  autoUrgeSuccessKeywordPlaceholder: string
  autoUrgeReenableHint: string
  autoUrgeToggleTooltip: string
  weatherCityLabel: string
  weatherCityPlaceholder: string
  language: string
  languageChinese: string
  languageEnglish: string
  theme: string
  light: string
  dark: string
  systemTheme: string
  uiScale: string
  fontScale: string
  lineHeight: string
  neteaseMusic: string
  showAlbumCover: string
  neteaseLogout: string
  defaultRequestModels: string
  defaultRequestModelsNote: string
  gitAgentModel: string
  gitAgentModelNote: string
  systemPromptLabel: string
  systemPromptNote: string
  crossProviderSkillReuseLabel: string
  crossProviderSkillReuseNote: string
  restoreDefaultSystemPrompt: string
  applyToExistingChats: string
  resetInterfaceDefaults: string
  clickToSetPath: string
  pathPlaceholder: string
  selectFolder: string
  pathPickerUnavailable: string
  pathPickerOpenFailed: (message: string) => string
  copyColumn: string
  addChat: string
  deleteColumn: string
  empty: string
  emptyColumnTitle: string
  emptyColumnDescription: string
  addWorkspace: string
  resizeColumn: string
  deleteCard: string
  planMode: string
  placeholderSetWorkspace: string
  placeholderInputTask: string
  placeholderCliUnavailable: string
  removeAttachment: string
  pastedImageAlt: (index: number) => string
  pastedImagesReady: (count: number) => string
  imageAttachmentsRequireCodex: string
  stopRun: string
  sendMessage: string
  slashCommands: string
  loadingSlashCommands: string
  noMatchingSlashCommands: string
  resizeCard: string
  resizeCardTitle: string
  appBadge: string
  nativeBadge: string
  skillBadge: string
  codexDefaultModelLabel: string
  claudeDefaultModelLabel: string
  you: string
  assistant: string
  system: string
  log: string
  logWithProvider: (provider: string) => string
  unexpectedError: string
  runStopped: string
  userInterrupted: string
  localCliUnavailable: string
  statusProvider: string
  statusModel: string
  statusWorkspace: string
  statusSession: string
  statusCli: string
  statusSlashMode: string
  statusProviderDefaultModel: string
  statusWorkspaceUnset: string
  statusSessionPending: string
  statusCliAvailable: string
  statusCliUnavailable: string
  codexSlashMode: string
  claudeSlashMode: string
  currentModel: string
  modelCommandUsage: string
  unknownModel: (value: string) => string
  switchedModel: (model: string) => string
  newChat: string
  doubleClickToRename: string
  genericWorkspaceChannel: string
  developmentChannel: string
  reviewChannel: string
  featureChat: string
  planChat: string
  draftChat: string
  appSlashCommandsTitle: string
  appSlashHelp: string
  appSlashModel: string
  appSlashNew: string
  appSlashClear: string
  appSlashStatus: string
  claudeSlashCommandsFooter: string
  codexSlashCommandsFooterOne: string
  codexSlashCommandsFooterTwo: string
  claudeNativeCommandPrefix: string
  codexNativeCommandPrefix: string
  recentWorkspaces: string
  editPath: string
  clearRecent: string
  removeSelected: string
  noRecentWorkspaces: string
  back: string
  sessionHistory: string
  searchSessionHistory: string
  searchSessionHistoryPlaceholder: string
  noSessionHistory: string
  noMatchingSessionHistory: string
  externalHistory: string
  importSession: string
  loadingExternalHistory: string
  noExternalHistory: string
  noMatchingExternalHistory: string
  importingSession: string
  whiteNoiseEmptyTitle: string
  whiteNoiseEmptyDescription: string
  whiteNoisePlaceholder: string
  whiteNoiseGenerate: string
  whiteNoiseRandom: string
  whiteNoiseGenerating: string
  whiteNoiseDelete: string
  whiteNoiseStop: string
  whiteNoisePlaying: string
  whiteNoiseMasterVolume: string
  whiteNoiseNoLayers: string
  weatherCardLabel: string
  weatherFetchError: string
  weatherLoading: string
  weatherConditions: Record<string, string>
  forkConversation: string
  thinking: string
  composerSettings: string
  stickyNotePlaceholder: string
  stickyNoteTitle: string
  brainstormTitle: string
  brainstormPlaceholder: string
  brainstormAnswerCountLabel: string
  brainstormStart: string
  brainstormDeleteAll: string
  brainstormDeleteAnswer: string
  brainstormIdeaLabel: string
  brainstormRejectedCount: (count: number) => string
  brainstormGenerating: string
  brainstormWaiting: string
  brainstormIdleSlot: string
  brainstormEmptyHint: (count: number) => string
  emptyStateToolsLabel: string
  emptyStateGitDescription: string
  emptyStateFilesTitle: string
  emptyStateFilesDescription: string
  emptyStateStickyDescription: string
  emptyStateBrainstormDescription: string
  emptyStateWeatherDescription: string
  emptyStateMusicDescription: string
  emptyStateWhiteNoiseDescription: string

  // App Update
  settingsGroupUpdate: string
  updateChecking: string
  updateAvailable: (version: string) => string
  updateDownloading: (percent: number) => string
  updateReady: (version: string) => string
  updateInstallNow: string
  updateCheckNow: string
  updateNoUpdate: string
  updateError: string
  updateCurrentVersion: (version: string) => string
  clearUserDataButton: string
  clearUserDataDialogTitle: string
  clearUserDataDialogBody: string
  clearUserDataDialogChats: string
  clearUserDataDialogSettings: string
  clearUserDataDialogCaches: string
  clearUserDataDialogWarning: string
  clearUserDataCancel: string
  clearUserDataConfirm: string
  clearUserDataPending: string
  streamRecoveryReconnecting: (attempt: number, max: number | 'unlimited') => string
  streamRecoveryResumed: string
  streamRecoveryFailed: string
  streamRecoveryManualResume: string
}

const localeTextByLanguage: Record<AppLanguage, LocaleText> = {
  'zh-CN': {
    loadingEyebrow: 'Chill Vibe',
    loadingTitle: '正在连接本地工作区服务',
    loadingDescription: '正在恢复看板，并检查本地 CLI 是否可用。',
    serviceErrorTitle: '无法连接本地工作区服务',
    serviceErrorDescription: '请先启动开发服务器，然后再试一次。',
    retry: '重试',
    reset: '重置',
    openSettings: '打开设置',
    closeSettings: '关闭设置',
    settingsPanelHeading: '\u754c\u9762\u548c\u8bf7\u6c42\u8bbe\u7f6e',
    preferences: '偏好',
    settingsTitle: '设置',
    settingsGroupAppearance: '外观',
    settingsGroupMusic: '音乐',
    settingsGroupModels: '模型',
    settingsGroupEnvironment: '环境设置',
    settingsGroupUtility: '实用',
    settingsGroupExperimental: '卡片类型',
    settingsGroupData: '本地数据',

    experimentalMusicLabel: '网易云音乐',
    experimentalWhiteNoiseLabel: '白噪音',
    experimentalWeatherLabel: '天气',
    agentDoneSoundLabel: 'Agent 完成音效',
    agentDoneSoundVolumeLabel: '音量',
    autoUrgeLabel: '自动鞭策',
    autoUrgeTypesLabel: '鞭策类型',
    autoUrgeTypeNameLabel: '类型名称',
    autoUrgeTypeNamePlaceholder: '例如：严格验收',
    autoUrgeAddType: '新增鞭策类型',
    autoUrgeUseType: '使用此类型',
    autoUrgeCurrentType: '当前类型',
    autoUrgeRemoveType: '删除类型',
    autoUrgeRunningStatus: '鞭策中...',
    autoUrgeMessageLabel: '鞭策消息',
    autoUrgeMessagePlaceholder: '每次 Agent 回答后自动发送的消息',
    autoUrgeSuccessKeywordLabel: '成功触发词',
    autoUrgeSuccessKeywordPlaceholder: 'Agent 回复包含此词时停止鞭策',
    autoUrgeReenableHint: '当前已全局关闭；在这里勾选会重新打开，并只为当前会话启用。',
    autoUrgeToggleTooltip: '自动鞭策',
    weatherCityLabel: '天气城市',
    weatherCityPlaceholder: '留空自动定位，如：上海、Tokyo',
    language: '语言',
    languageChinese: '中文',
    languageEnglish: 'English',
    theme: '主题',
    light: '浅色',
    dark: '深色',
    systemTheme: '系统',
    uiScale: '界面缩放',
    fontScale: '字体缩放',
    lineHeight: '行高',
    neteaseMusic: '网易云音乐',
    showAlbumCover: '显示专辑封面',
    neteaseLogout: '注销网易云',
    defaultRequestModels: '默认请求模型',
    defaultRequestModelsNote: '新会话会默认使用这些模型，你也可以同步到现有会话。',
    gitAgentModel: 'Git 卡片 AI 模型',
    gitAgentModelNote: 'Git 分析使用的模型，格式：模型名称 推理强度（如 gpt-5.5 xhigh）。',
    systemPromptLabel: '系统提示词',
    systemPromptNote: '每次 AI 运行前都会附加这条系统提示词。恢复默认可回到内置提示词。',
    crossProviderSkillReuseLabel: 'Codex / Claude Skill 互相复用',
    crossProviderSkillReuseNote:
      '启用后，斜杠菜单和实际 AI 运行都可以复用当前工作区或用户目录里的 .codex/skills 和 .claude/skills，不用复制两份。',
    restoreDefaultSystemPrompt: '恢复内置提示词',
    applyToExistingChats: '应用到现有会话',
    resetInterfaceDefaults: '重置界面默认值',
    clickToSetPath: '点击设置路径',
    pathPlaceholder: '例如 D:\\项目\\示例目录',
    selectFolder: '选择文件夹',
    pathPickerUnavailable:
      '当前窗口没有系统目录选择能力。请直接粘贴绝对路径，或用 `pnpm electron:dev` 启动桌面版。',
    pathPickerOpenFailed: (message) => `打开目录选择器失败：${message}`,
    copyColumn: '复制列',
    addChat: '新增会话',
    deleteColumn: '删除列',
    empty: '空列',
    emptyColumnTitle: '这一列已经没有卡片了',
    emptyColumnDescription: '点击右上角加号可以新建会话，也可以把别的卡片拖进来。',
    addWorkspace: '新增工作区',
    resizeColumn: '拖拽调整列宽',
    deleteCard: '删除卡片',
    planMode: '计划模式',
    forkConversation: '从此处分叉',
    thinking: '思考',
    composerSettings: '对话设置',
    placeholderSetWorkspace: '请先设置工作区路径',
    placeholderInputTask: '输入任务，回车发送',
    placeholderCliUnavailable: '命令行不可用',
    removeAttachment: '移除图片',
    pastedImageAlt: (index) => `粘贴图片 ${index}`,
    pastedImagesReady: (count) => `已粘贴 ${count} 张图片，可随下一条消息一起发送。`,
    imageAttachmentsRequireCodex: '粘贴图片暂不支持当前 provider，请移除图片后重试。',
    stopRun: '停止运行',
    sendMessage: '发送消息',
    slashCommands: '斜杠命令',
    loadingSlashCommands: '正在加载斜杠命令...',
    noMatchingSlashCommands: '没有匹配的斜杠命令。',
    resizeCard: '调整卡片高度',
    resizeCardTitle: '拖动调整卡片高度',
    appBadge: '应用',
    nativeBadge: '原生',
    skillBadge: 'Skill',
    codexDefaultModelLabel: 'Codex',
    claudeDefaultModelLabel: 'Claude',
    you: '你',
    assistant: '助手',
    system: '系统',
    log: '日志',
    logWithProvider: (provider) => `日志 · ${provider}`,
    unexpectedError: '发生了未知错误。',
    runStopped: '这次运行已停止。',
    userInterrupted: '用户打断',
    localCliUnavailable: '本地 CLI 不可用。',
    statusProvider: '提供方',
    statusModel: '卡片类型',
    statusWorkspace: '工作区',
    statusSession: '会话',
    statusCli: 'CLI',
    statusSlashMode: '斜杠命令模式',
    statusProviderDefaultModel: '提供方默认值',
    statusWorkspaceUnset: '未设置',
    statusSessionPending: '尚未开始',
    statusCliAvailable: '可用',
    statusCliUnavailable: '不可用',
    codexSlashMode:
      '仅支持本地子集（这个看板使用 `codex exec`，不是交互式 Codex TUI）。',
    claudeSlashMode: '支持应用内命令，以及 Claude CLI 在当前工作区暴露的原生命令。',
    currentModel: '当前模型',
    modelCommandUsage: '用法：/model <name>',
    unknownModel: (value) =>
      `未知模型“${value}”。使用 /model 查看这个卡片支持的模型别名。`,
    switchedModel: (model) => `已切换到模型 ${model}。`,
    newChat: '新会话',
    doubleClickToRename: '双击重命名',
    genericWorkspaceChannel: '工作区通道',
    developmentChannel: '开发通道',
    reviewChannel: '评审通道',
    featureChat: '功能会话',
    planChat: '方案会话',
    draftChat: '草稿会话',
    appSlashCommandsTitle: '应用内斜杠命令：',
    appSlashHelp: '/help - 显示这份帮助',
    appSlashModel: '/model <name> - 切换当前卡片模型',
    appSlashNew: '/new - 在当前卡片中开始新会话',
    appSlashClear: '/clear - 清空消息并重置当前会话',
    appSlashStatus: '/status - 查看提供方、模型、工作区与会话信息',
    claudeSlashCommandsFooter:
      '当本地 CLI 在当前工作区暴露命令时，Claude 原生斜杠命令也可用。',
    codexSlashCommandsFooterOne:
      '除了这组子集之外，Codex 原生斜杠命令需要交互式 Codex TUI。',
    codexSlashCommandsFooterTwo: '这个看板当前通过 `codex exec` 与 Codex 通信。',
    claudeNativeCommandPrefix: 'Claude 原生斜杠命令',
    codexNativeCommandPrefix: 'Codex 原生斜杠命令',
    recentWorkspaces: '最近工作区',
    editPath: '编辑路径...',
    clearRecent: '清除最近打开...',
    removeSelected: '移除选中',
    noRecentWorkspaces: '没有最近的工作区',
    back: '返回',
    sessionHistory: '会话历史',
    searchSessionHistory: '\u641c\u7d22\u4f1a\u8bdd\u5386\u53f2',
    searchSessionHistoryPlaceholder: '\u6309\u6807\u9898\u3001\u6a21\u578b\u3001\u8def\u5f84\u6216\u6d88\u606f\u5185\u5bb9\u641c\u7d22',
    noSessionHistory: '没有历史会话',
    noMatchingSessionHistory: '\u6ca1\u6709\u5339\u914d\u7684\u5386\u53f2\u4f1a\u8bdd',
    externalHistory: '外部历史',
    importSession: '导入',
    loadingExternalHistory: '正在扫描外部历史...',
    noExternalHistory: '未找到外部会话',
    noMatchingExternalHistory: '\u6ca1\u6709\u5339\u914d\u7684\u5916\u90e8\u4f1a\u8bdd',
    importingSession: '导入中...',
    whiteNoiseEmptyTitle: '还没有场景',
    whiteNoiseEmptyDescription: '描述你想要的氛围，AI 会为你生成一个白噪音场景。',
    whiteNoisePlaceholder: '描述你想要的氛围...',
    whiteNoiseGenerate: '生成',
    whiteNoiseRandom: '随机',
    whiteNoiseGenerating: '正在生成...',
    whiteNoiseDelete: '删除场景',
    whiteNoiseStop: '停止',
    whiteNoisePlaying: '正在播放',
    whiteNoiseMasterVolume: '主音量',
    whiteNoiseNoLayers: '该场景暂无音频图层，等待 AI 补充音源。',
    weatherCardLabel: '天气氛围',
    weatherFetchError: '无法获取天气',
    weatherLoading: '加载中...',
    weatherConditions: {
      'sunny': '晴',
      'clear-night': '晴夜',
      'partly-cloudy': '多云',
      'cloudy': '阴',
      'overcast': '阴天',
      'rainy': '雨',
      'drizzle': '小雨',
      'thunderstorm': '雷阵雨',
      'snowy': '雪',
      'foggy': '雾',
      'windy': '有风',
    },
    stickyNotePlaceholder: '写点什么…',
    stickyNoteTitle: '便签',
    brainstormTitle: '头脑风暴',
    brainstormPlaceholder: '输入主题…',
    brainstormAnswerCountLabel: '答案数量',
    brainstormStart: '开始头脑风暴',
    brainstormDeleteAll: '全部删除',
    brainstormDeleteAnswer: '删除答案',
    brainstormIdeaLabel: '方案',
    brainstormRejectedCount: (count) => `已记录 ${count} 条失败案例，补位时会自动避开这些思路。`,
    brainstormGenerating: '正在生成方案…',
    brainstormWaiting: '等待补位…',
    brainstormIdleSlot: '等待开始',
    brainstormEmptyHint: (count) => `开始后会并行生成 ${count} 条方案。`,
    emptyStateToolsLabel: '快捷功能卡',
    emptyStateGitDescription: '查看仓库状态，分析改动并继续同步。',
    emptyStateFilesTitle: '文件',
    emptyStateFilesDescription: '快速浏览和跳转工作区内容。',
    emptyStateStickyDescription: '随手记下想法和待办。',
    emptyStateBrainstormDescription: '让多个 agent 并行给出不同脑暴方向，删掉弱答案后会自动补位。',
    emptyStateWeatherDescription: '让当前环境更有感觉。',
    emptyStateMusicDescription: '在工作时挂一条背景声轨。',
    emptyStateWhiteNoiseDescription: '生成一组专注白噪音，铺一层工作氛围。',

    settingsGroupUpdate: '应用更新',
    updateChecking: '正在检查更新...',
    updateAvailable: (version) => `发现新版本 ${version}`,
    updateDownloading: (percent) => `正在下载更新... ${percent}%`,
    updateReady: (version) => `新版本 ${version} 已下载完成，点击后将自动替换当前应用目录并重启。`,
    updateInstallNow: '更新并重启',
    updateCheckNow: '检查更新',
    updateNoUpdate: '当前已是最新版本。',
    updateError: '检查更新时出错。',
    updateCurrentVersion: (version) => `当前版本：${version}`,
    clearUserDataButton: '清理用户数据',
    clearUserDataDialogTitle: '清理用户数据？',
    clearUserDataDialogBody: '这会删除当前设备上的本地数据，并在清理后自动重启应用。',
    clearUserDataDialogChats: '聊天记录、看板布局和会话元数据',
    clearUserDataDialogSettings: 'Provider 配置、API Key、音乐登录状态和偏好设置',
    clearUserDataDialogCaches: '附件缓存、白噪音音频缓存和其他本地缓存文件',
    clearUserDataDialogWarning: '此操作不可撤销。',
    clearUserDataCancel: '取消',
    clearUserDataConfirm: '清理并重启',
    clearUserDataPending: '正在清理并重启...',
    streamRecoveryReconnecting: (attempt, max) => `正在重连… ${attempt}/${max}`,
    streamRecoveryResumed: '已恢复',
    streamRecoveryFailed: '重连失败',
    streamRecoveryManualResume: '手动续传',
  },
  en: {
    loadingEyebrow: 'Chill Vibe',
    loadingTitle: 'Connecting to the local workspace service',
    loadingDescription: 'Restoring your board and checking whether the local CLIs are available.',
    serviceErrorTitle: 'Unable to reach the local workspace service',
    serviceErrorDescription: 'Start the dev server first, then try again.',
    retry: 'Retry',
    reset: 'Reset',
    openSettings: 'Open settings',
    closeSettings: 'Close settings',
    preferences: 'Preferences',
    settingsTitle: 'Settings',
    settingsPanelHeading: 'Interface and request settings',
    settingsGroupAppearance: 'Appearance',
    settingsGroupMusic: 'Music',
    settingsGroupModels: 'Models',
    settingsGroupEnvironment: 'Environment',
    settingsGroupUtility: 'Utility',
    settingsGroupExperimental: 'Card Type',
    settingsGroupData: 'Local Data',

    experimentalMusicLabel: 'NetEase Music',
    experimentalWhiteNoiseLabel: 'White Noise',
    experimentalWeatherLabel: 'Weather',
    agentDoneSoundLabel: 'Agent Done Sound',
    agentDoneSoundVolumeLabel: 'Volume',
    autoUrgeLabel: 'Auto Urge',
    autoUrgeTypesLabel: 'Urge Types',
    autoUrgeTypeNameLabel: 'Type Name',
    autoUrgeTypeNamePlaceholder: 'e.g. Release Guard',
    autoUrgeAddType: 'Add Auto Urge Type',
    autoUrgeUseType: 'Use This Type',
    autoUrgeCurrentType: 'Current Type',
    autoUrgeRemoveType: 'Remove Type',
    autoUrgeRunningStatus: 'Urging...',
    autoUrgeMessageLabel: 'Urge Message',
    autoUrgeMessagePlaceholder: 'Message sent automatically after each agent response',
    autoUrgeSuccessKeywordLabel: 'Success Keyword',
    autoUrgeSuccessKeywordPlaceholder: 'Stop urging when agent reply contains this keyword',
    autoUrgeReenableHint:
      'Auto Urge is currently off globally. Checking it here turns it back on for this chat.',
    autoUrgeToggleTooltip: 'Auto Urge',
    weatherCityLabel: 'Weather city',
    weatherCityPlaceholder: 'Auto-detect if empty, e.g. Shanghai, Tokyo',
    language: 'Language',
    languageChinese: 'Chinese',
    languageEnglish: 'English',
    theme: 'Theme',
    light: 'Light',
    dark: 'Dark',
    systemTheme: 'System',
    uiScale: 'UI scale',
    fontScale: 'Font scale',
    lineHeight: 'Line height',
    neteaseMusic: 'NetEase Music',
    showAlbumCover: 'Show album cover',
    neteaseLogout: 'Sign out of NetEase',
    defaultRequestModels: 'Default request models',
    defaultRequestModelsNote:
      'New chats will use these models by default, and you can sync them into existing chats.',
    gitAgentModel: 'Git card AI model',
    gitAgentModelNote: 'Model used for Git analysis. Format: model-name reasoning-effort (e.g. gpt-5.5 xhigh).',
    systemPromptLabel: 'System prompt',
    systemPromptNote:
      'This prompt is appended before each AI run. Restore default to go back to the built-in prompt.',
    crossProviderSkillReuseLabel: 'Reuse Codex / Claude skills',
    crossProviderSkillReuseNote:
      'When enabled, slash menus and provider runs can reuse .codex/skills and .claude/skills from the current workspace or user home without copying them twice.',
    restoreDefaultSystemPrompt: 'Restore built-in prompt',
    applyToExistingChats: 'Apply to existing chats',
    resetInterfaceDefaults: 'Reset interface defaults',
    clickToSetPath: 'Click to set path',
    pathPlaceholder: 'For example D:\\projects\\demo',
    selectFolder: 'Select folder',
    pathPickerUnavailable:
      'This window cannot open the system folder picker. Paste an absolute path, or launch the desktop app with `pnpm electron:dev`.',
    pathPickerOpenFailed: (message) => `Failed to open the folder picker: ${message}`,
    copyColumn: 'Copy column',
    addChat: 'Add chat',
    deleteColumn: 'Delete column',
    empty: 'Empty',
    emptyColumnTitle: 'This column has no cards yet',
    emptyColumnDescription: 'Use the add button above, or drag a card here to keep going.',
    addWorkspace: 'Add workspace',
    resizeColumn: 'Drag to resize column width',
    deleteCard: 'Delete card',
    planMode: 'Plan mode',
    forkConversation: 'Fork from here',
    thinking: 'Thinking',
    composerSettings: 'Chat settings',
    placeholderSetWorkspace: 'Set a workspace path first',
    placeholderInputTask: 'Type a task and press Enter',
    placeholderCliUnavailable: 'CLI unavailable',
    removeAttachment: 'Remove image',
    pastedImageAlt: (index) => `Pasted image ${index}`,
    pastedImagesReady: (count) =>
      `${count} pasted image${count === 1 ? '' : 's'} ready to send with the next message.`,
    imageAttachmentsRequireCodex:
      'Image attachments are not supported by the current provider. Remove the images and try again.',
    stopRun: 'Stop run',
    sendMessage: 'Send message',
    slashCommands: 'Slash commands',
    loadingSlashCommands: 'Loading slash commands...',
    noMatchingSlashCommands: 'No matching slash commands.',
    resizeCard: 'Resize card height',
    resizeCardTitle: 'Drag to resize card height',
    appBadge: 'App',
    nativeBadge: 'Native',
    skillBadge: 'Skill',
    codexDefaultModelLabel: 'Codex default',
    claudeDefaultModelLabel: 'Claude CLI default',
    you: 'You',
    assistant: 'Assistant',
    system: 'System',
    log: 'Log',
    logWithProvider: (provider) => `Log · ${provider}`,
    unexpectedError: 'An unexpected error occurred.',
    runStopped: 'This run was stopped.',
    userInterrupted: 'User interrupted',
    localCliUnavailable: 'The local CLI is not available.',
    statusProvider: 'Provider',
    statusModel: 'Card Type',
    statusWorkspace: 'Workspace',
    statusSession: 'Session',
    statusCli: 'CLI',
    statusSlashMode: 'Slash mode',
    statusProviderDefaultModel: 'provider default',
    statusWorkspaceUnset: 'not set',
    statusSessionPending: 'not started yet',
    statusCliAvailable: 'available',
    statusCliUnavailable: 'unavailable',
    codexSlashMode:
      'Local subset only (this board uses `codex exec`, not the interactive Codex TUI).',
    claudeSlashMode:
      'App-local commands plus Claude native commands exposed for this workspace.',
    currentModel: 'Current model',
    modelCommandUsage: 'Usage: /model <name>',
    unknownModel: (value) =>
      `Unknown model "${value}". Use /model to list the supported model aliases for this card.`,
    switchedModel: (model) => `Switched model to ${model}.`,
    newChat: 'New chat',
    doubleClickToRename: 'Double-click to rename',
    genericWorkspaceChannel: 'Workspace channel',
    developmentChannel: 'Development channel',
    reviewChannel: 'Review channel',
    featureChat: 'Feature chat',
    planChat: 'Plan chat',
    draftChat: 'Draft chat',
    appSlashCommandsTitle: 'App slash commands:',
    appSlashHelp: '/help - show this help',
    appSlashModel: '/model <name> - switch the current card model',
    appSlashNew: '/new - start a fresh chat in this card',
    appSlashClear: '/clear - clear messages and reset the current chat',
    appSlashStatus: '/status - show provider, model, workspace, and session info',
    claudeSlashCommandsFooter:
      'Claude native slash commands are also available when the local CLI exposes them for this workspace.',
    codexSlashCommandsFooterOne:
      'Codex native slash commands beyond this subset require the interactive Codex TUI.',
    codexSlashCommandsFooterTwo:
      'This board currently talks to Codex through `codex exec`.',
    claudeNativeCommandPrefix: 'Claude slash command',
    codexNativeCommandPrefix: 'Codex slash command',
    recentWorkspaces: 'Recent workspaces',
    editPath: 'Edit path...',
    clearRecent: 'Clear recent...',
    removeSelected: 'Remove selected',
    noRecentWorkspaces: 'No recent workspaces',
    back: 'Back',
    sessionHistory: 'Session history',
    searchSessionHistory: 'Search session history',
    searchSessionHistoryPlaceholder: 'Search by title, model, path, or message text',
    noSessionHistory: 'No session history',
    noMatchingSessionHistory: 'No matching session history',
    externalHistory: 'External history',
    importSession: 'Import',
    loadingExternalHistory: 'Scanning external history...',
    noExternalHistory: 'No external sessions found',
    noMatchingExternalHistory: 'No matching external sessions',
    importingSession: 'Importing...',
    whiteNoiseEmptyTitle: 'No scenes yet',
    whiteNoiseEmptyDescription: 'Describe the vibe you want and AI will generate an ambient scene for you.',
    whiteNoisePlaceholder: 'Describe the vibe you want...',
    whiteNoiseGenerate: 'Generate',
    whiteNoiseRandom: 'Random',
    whiteNoiseGenerating: 'Generating...',
    whiteNoiseDelete: 'Delete scene',
    whiteNoiseStop: 'Stop',
    whiteNoisePlaying: 'Playing',
    whiteNoiseMasterVolume: 'Master volume',
    whiteNoiseNoLayers: 'This scene has no audio layers yet. AI will find sources later.',
    weatherCardLabel: 'Weather Ambience',
    weatherFetchError: 'Unable to fetch weather',
    weatherLoading: 'Loading...',
    weatherConditions: {
      'sunny': 'Sunny',
      'clear-night': 'Clear Night',
      'partly-cloudy': 'Partly Cloudy',
      'cloudy': 'Cloudy',
      'overcast': 'Overcast',
      'rainy': 'Rain',
      'drizzle': 'Drizzle',
      'thunderstorm': 'Thunderstorm',
      'snowy': 'Snow',
      'foggy': 'Foggy',
      'windy': 'Windy',
    },
    stickyNotePlaceholder: 'Write something…',
    stickyNoteTitle: 'Sticky Note',
    brainstormTitle: 'Brainstorm',
    brainstormPlaceholder: 'Enter a topic…',
    brainstormAnswerCountLabel: 'Answer count',
    brainstormStart: 'Start Brainstorm',
    brainstormDeleteAll: 'Delete all',
    brainstormDeleteAnswer: 'Delete answer',
    brainstormIdeaLabel: 'Idea',
    brainstormRejectedCount: (count) =>
      `${count} rejected idea${count === 1 ? '' : 's'} will be avoided during refill.`,
    brainstormGenerating: 'Generating ideas…',
    brainstormWaiting: 'Waiting for refill…',
    brainstormIdleSlot: 'Waiting to start.',
    brainstormEmptyHint: (count) => `Will generate ${count} idea${count === 1 ? '' : 's'}.`,
    emptyStateToolsLabel: 'Quick tool cards',
    emptyStateGitDescription: 'Review repo status, analyze changes, and keep sync close by.',
    emptyStateFilesTitle: 'Files',
    emptyStateFilesDescription: 'Open the file tree for quick workspace browsing and jumps.',
    emptyStateStickyDescription: 'Open a scratchpad for quick notes and loose todos.',
    emptyStateBrainstormDescription:
      'Run multiple agents in parallel, delete weak ideas, and auto-refill with fresher angles.',
    emptyStateWeatherDescription: 'Bring in the weather ambience card for the current mood.',
    emptyStateMusicDescription: 'Open NetEase Music and keep a soundtrack running nearby.',
    emptyStateWhiteNoiseDescription: 'Generate a layered focus scene with ambient white noise.',

    settingsGroupUpdate: 'App Update',
    updateChecking: 'Checking for updates...',
    updateAvailable: (version) => `Version ${version} is available`,
    updateDownloading: (percent) => `Downloading update... ${percent}%`,
    updateReady: (version) =>
      `Version ${version} is ready. Chill Vibe will replace the local app folder and restart automatically.`,
    updateInstallNow: 'Update and Restart',
    updateCheckNow: 'Check for Updates',
    updateNoUpdate: 'You are on the latest version.',
    updateError: 'Error checking for updates.',
    updateCurrentVersion: (version) => `Current version: ${version}`,
    clearUserDataButton: 'Clear User Data',
    clearUserDataDialogTitle: 'Clear User Data?',
    clearUserDataDialogBody: 'This removes local app data on this device and restarts Chill Vibe with a clean state.',
    clearUserDataDialogChats: 'Local chat history, board layout, and session metadata',
    clearUserDataDialogSettings: 'Provider profiles, API keys, music sign-in, and saved preferences',
    clearUserDataDialogCaches: 'Cached attachments, white-noise audio, and other local cached files',
    clearUserDataDialogWarning: 'This action cannot be undone.',
    clearUserDataCancel: 'Cancel',
    clearUserDataConfirm: 'Clear and Restart',
    clearUserDataPending: 'Clearing and restarting...',
    streamRecoveryReconnecting: (attempt, max) => `Reconnecting… ${attempt}/${max}`,
    streamRecoveryResumed: 'Resumed',
    streamRecoveryFailed: 'Reconnect failed',
    streamRecoveryManualResume: 'Resume manually',
  },
}

export const normalizeLanguage = (language?: AppLanguage | null): AppLanguage =>
  language === 'en' ? 'en' : defaultAppLanguage

export const getLocaleText = (language: AppLanguage) =>
  localeTextByLanguage[normalizeLanguage(language)]

// ── Git locale text ─────────────────────────────────────────────────────────

type GitLocaleText = {
  loading: string
  refresh: string
  pull: string
  push: string
  commitSelected: string
  commitAll: string
  commitAllPlaceholder: string
  summary: string
  description: string
  branch: string
  repository: string
  actions: string
  changesTab: string
  historyTab: string
  filterLabel: string
  filterPlaceholder: string
  staged: string
  unstaged: string
  untracked: string
  conflicted: string
  cleanTitle: string
  cleanCopy: string
  noWorkspaceTitle: string
  noWorkspaceCopy: string
  notRepoTitle: string
  notRepoCopy: string
  lastCommit: string
  diffPreview: string
  composeCommit: string
  selectChangeTitle: string
  selectChangeCopy: string
  noMatchesTitle: string
  noMatchesCopy: string
  noDiffTitle: string
  noDiffCopy: string
  noHistoryTitle: string
  noHistoryCopy: string
  changedFiles: (count: number) => string
  totalAddRemove: (added: number, removed: number) => string
  moreFiles: (count: number) => string
  ahead: (count: number) => string
  behind: (count: number) => string
  commitPlaceholder: string
  descriptionPlaceholder: string
  resolveConflicts: string
  markResolved: string
  stagedToggleOn: (path: string) => string
  stagedToggleOff: (path: string) => string
  refreshError: string
  stageError: string
  pullError: string
  pushError: string
  commitError: string
  commitAllError: string
  commitSuccess: (hash: string, summary: string) => string
  commitAllSuccess: (hash: string, summary: string) => string
  pushSuccess: string
  analyzeChanges: string
  commitNew: string
  analyzing: string
  openFullGit: string
  closeFullGit: string
  commitNewEmptyTitle: string
  commitNewEmptyCopy: string
  analyzeChangesTooltip: string
  commitNewTooltip: string
  syncTooltip: string
  openFullGitTooltip: string
  stageAll: string
  unstageAll: string
  agentSuggestion: string
  executeStrategy: string
  agentCommitAll: string
  agentCommitPartial: string
  cancelStrategy: string
  loadMore: string
  commitDiff: string
  noUpstream: string
  sync: string
  syncing: string
  syncSuccess: string
  syncError: string
  syncConflictResolving: string
  syncStepPull: string
  syncStepPush: string
  syncStepConflict: string
  syncConfirmCommitMessage: (count: number) => string
  syncConfirmCommitYes: string
  syncConfirmCommitNo: string
  syncStepCommit: string
}

const gitLocaleTextByLanguage: Record<AppLanguage, GitLocaleText> = {
  'zh-CN': {
    loading: '正在加载本地改动...',
    refresh: '刷新',
    pull: '拉取',
    push: '推送',
    commitSelected: '提交已暂存内容',
    commitAll: '全部提交',
    commitAllPlaceholder: '输入提交信息后一键全部提交',
    summary: '摘要',
    description: '描述',
    branch: '当前分支',
    repository: '当前仓库',
    actions: '仓库操作',
    changesTab: '变更',
    historyTab: '历史',
    filterLabel: '筛选变更',
    filterPlaceholder: '筛选改动文件',
    staged: '已暂存',
    unstaged: '未暂存',
    untracked: '未跟踪',
    conflicted: '冲突',
    cleanTitle: '工作区已干净',
    cleanCopy: '当前没有等待提交的本地改动。',
    noWorkspaceTitle: '请先设置工作区路径',
    noWorkspaceCopy: 'Git 卡片需要一个可用的工作区才能检查状态。',
    notRepoTitle: '当前工作区不是 Git 仓库',
    notRepoCopy: '请在这里运行 git init，或切换到已检出的仓库路径。',
    lastCommit: '最近一次提交',
    diffPreview: '差异预览',
    composeCommit: '填写提交信息',
    selectChangeTitle: '选择一个文件',
    selectChangeCopy: '从左侧选择一个改动文件后，就会在这里显示补丁预览。',
    noMatchesTitle: '没有匹配的文件',
    noMatchesCopy: '试试更短的关键字，或者清空筛选框。',
    noDiffTitle: '没有可内联预览的差异',
    noDiffCopy: '这个文件仍然可以暂存和提交，只是当前没有生成文本补丁。',
    noHistoryTitle: '还没有历史记录',
    noHistoryCopy: '先创建一次提交，这里就会显示出来。',
    changedFiles: (count) => `${count} 个已改动文件`,
    totalAddRemove: (added, removed) => `+${added} / -${removed}`,
    moreFiles: (count) => `还有 ${count} 个文件...`,
    ahead: (count) => `领先 ${count}`,
    behind: (count) => `落后 ${count}`,
    commitPlaceholder: '输入简短摘要',
    descriptionPlaceholder: '可选：补充提交正文细节。',
    resolveConflicts: '合并冲突会阻止提交。请先在编辑器里解决冲突，然后回到这里刷新并暂存。',
    markResolved: '冲突解决后请刷新，这里会重新显示可暂存状态。',
    stagedToggleOn: (path) => `暂存 ${path}`,
    stagedToggleOff: (path) => `取消暂存 ${path}`,
    refreshError: '无法刷新 Git 状态。',
    stageError: '无法更新暂存文件。',
    pullError: '无法拉取最新改动。',
    pushError: '无法推送改动。',
    commitError: '无法创建提交。',
    commitAllError: '无法提交所有改动。',
    commitSuccess: (hash, summary) => `已创建 ${hash}: ${summary}`,
    commitAllSuccess: (hash, summary) => `已提交全部改动 ${hash}: ${summary}`,
    pushSuccess: '推送成功。',
    analyzeChanges: '分析改动',
    commitNew: '提交新增',
    analyzing: '正在分析...',
    openFullGit: '古法 Git',
    closeFullGit: '关闭',
    commitNewEmptyTitle: '上次快照以来没有新增改动',
    commitNewEmptyCopy: '这里只会提交自上次打开 Git 以来新增或发生变化的文件。',
    analyzeChangesTooltip: '让 Agent 总结当前改动，并给出提交策略。',
    commitNewTooltip: '一键提交自上次 Git 快照以来新增或变化的文件。',
    syncTooltip: '先拉取远程改动，必要时尝试自动解决冲突，然后再推送。',
    openFullGitTooltip: '打开完整 Git 视图，手动勾选文件、查看 diff 和历史。',
    stageAll: '全选',
    unstageAll: '取消全选',
    agentSuggestion: 'Agent 建议',
    executeStrategy: '执行策略',
    agentCommitAll: '全部提交',
    agentCommitPartial: '部分提交',
    cancelStrategy: '取消',
    loadMore: '加载更多',
    commitDiff: '查看差异',
    noUpstream: '尚未设置上游分支，将自动设置。',
    sync: '同步',
    syncing: '正在同步...',
    syncSuccess: '同步完成。',
    syncError: '同步失败。',
    syncConflictResolving: '检测到冲突，正在调用 Codex 解决...',
    syncStepPull: '正在拉取远程改动...',
    syncStepPush: '正在推送到远程...',
    syncStepConflict: '正在解决合并冲突...',
    syncConfirmCommitMessage: (count) => `检测到 ${count} 个本地文件与远端改动冲突，需要先提交这些文件才能同步。是否现在提交？`,
    syncConfirmCommitYes: '提交后同步',
    syncConfirmCommitNo: '取消',
    syncStepCommit: '正在提交本地改动...',
  },
  en: {
    loading: 'Loading local changes...',
    refresh: 'Refresh',
    pull: 'Pull',
    push: 'Push',
    commitSelected: 'Commit selected',
    commitAll: 'Commit all',
    commitAllPlaceholder: 'Enter a message to commit all changes',
    summary: 'Summary',
    description: 'Description',
    branch: 'Current branch',
    repository: 'Current repository',
    actions: 'Repository actions',
    changesTab: 'Changes',
    historyTab: 'History',
    filterLabel: 'Filter changes',
    filterPlaceholder: 'Filter changed files',
    staged: 'Staged',
    unstaged: 'Unstaged',
    untracked: 'Untracked',
    conflicted: 'Conflicted',
    cleanTitle: 'Working tree clean',
    cleanCopy: 'No local changes are waiting to be committed.',
    noWorkspaceTitle: 'Set a workspace path first',
    noWorkspaceCopy: 'The Git tool needs an active workspace to inspect.',
    notRepoTitle: 'This workspace is not a Git repository',
    notRepoCopy: 'Run git init here or point the card at a checked-out repository.',
    lastCommit: 'Last commit',
    diffPreview: 'Diff preview',
    composeCommit: 'Compose commit',
    selectChangeTitle: 'Select a file',
    selectChangeCopy: 'Choose a changed file to inspect its patch.',
    noMatchesTitle: 'No matching files',
    noMatchesCopy: 'Try a shorter filter or clear it.',
    noDiffTitle: 'No inline diff available',
    noDiffCopy: 'This file can still be staged and committed, but no text diff was produced.',
    noHistoryTitle: 'No history yet',
    noHistoryCopy: 'Create the first commit to see it here.',
    changedFiles: (count) => `${count} changed file${count === 1 ? '' : 's'}`,
    totalAddRemove: (added, removed) => `+${added} / -${removed}`,
    moreFiles: (count) => `${count} more file${count === 1 ? '' : 's'}...`,
    ahead: (count) => `Ahead ${count}`,
    behind: (count) => `Behind ${count}`,
    commitPlaceholder: 'Write a short summary',
    descriptionPlaceholder: 'Optional details for the body of the commit message.',
    resolveConflicts:
      'Merge conflicts are blocking commits. Resolve the files in your editor, then refresh and stage them here.',
    markResolved: 'Refresh after resolving conflicts to stage the files here.',
    stagedToggleOn: (path) => `Stage ${path}`,
    stagedToggleOff: (path) => `Unstage ${path}`,
    refreshError: 'Unable to refresh the Git status.',
    stageError: 'Unable to update the staged files.',
    pullError: 'Unable to pull the latest changes.',
    pushError: 'Unable to push changes.',
    commitError: 'Unable to create the commit.',
    commitAllError: 'Unable to commit all changes.',
    commitSuccess: (hash, summary) => `Created ${hash}: ${summary}`,
    commitAllSuccess: (hash, summary) => `Committed all changes ${hash}: ${summary}`,
    pushSuccess: 'Pushed successfully.',
    analyzeChanges: 'Analyze changes',
    commitNew: 'Commit new',
    analyzing: 'Analyzing...',
    openFullGit: 'Full Git',
    closeFullGit: 'Close',
    commitNewEmptyTitle: 'No changes since the last Git snapshot',
    commitNewEmptyCopy: 'This flow only commits files that changed since the last time Git was opened here.',
    analyzeChangesTooltip: 'Ask the agent to review the current changes and suggest commit strategies.',
    commitNewTooltip: 'One-click commit files changed since the last Git snapshot.',
    syncTooltip: 'Pull remote changes, resolve conflicts when needed, then push.',
    openFullGitTooltip: 'Open the full Git view for diffs, history, and manual staging.',
    stageAll: 'Select all',
    unstageAll: 'Deselect all',
    agentSuggestion: 'Agent suggestion',
    executeStrategy: 'Execute strategy',
    agentCommitAll: 'Commit all',
    agentCommitPartial: 'Partial commit',
    cancelStrategy: 'Cancel',
    loadMore: 'Load more',
    commitDiff: 'View diff',
    noUpstream: 'No upstream branch set; will configure automatically.',
    sync: 'Sync',
    syncing: 'Syncing...',
    syncSuccess: 'Sync complete.',
    syncError: 'Sync failed.',
    syncConflictResolving: 'Conflicts detected, invoking Codex to resolve...',
    syncStepPull: 'Pulling remote changes...',
    syncStepPush: 'Pushing to remote...',
    syncStepConflict: 'Resolving merge conflicts...',
    syncConfirmCommitMessage: (count) => `${count} local file(s) conflict with incoming remote changes. Commit them before syncing?`,
    syncConfirmCommitYes: 'Commit & sync',
    syncConfirmCommitNo: 'Cancel',
    syncStepCommit: 'Committing conflicting files...',
  },
}

export const getGitLocaleText = (language: AppLanguage) =>
  gitLocaleTextByLanguage[normalizeLanguage(language)]

export const getProviderLabel = (_language: AppLanguage, provider: Provider) =>
  provider === 'claude' ? 'Claude' : 'Codex'

export const getWorkspaceTitle = (language: AppLanguage, index: number) =>
  language === 'en' ? `Workspace ${index}` : `工作区 ${index}`

export const getDuplicateColumnTitle = (language: AppLanguage, title: string) =>
  language === 'en' ? `${title} Copy` : `${title} 副本`

export const getForkConversationTitle = (language: AppLanguage, title: string) =>
  language === 'en' ? `${title} (fork)` : `${title} (分叉)`

export const getIndexedChatTitle = (language: AppLanguage, index: number) =>
  language === 'en' ? `Question ${index}` : `问题${index}`

export const formatLocalizedTime = (language: AppLanguage, value: string) =>
  new Intl.DateTimeFormat(normalizeLanguage(language), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

export const formatLocalizedDateTime = (language: AppLanguage, value: string) =>
  new Intl.DateTimeFormat(normalizeLanguage(language), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

export const getSlashCommandSourceLabel = (
  language: AppLanguage,
  source: SlashCommandSource,
) => {
  const text = getLocaleText(language)
  if (source === 'skill') {
    return text.skillBadge
  }

  return source === 'native' ? text.nativeBadge : text.appBadge
}

export const getMessageLabel = (language: AppLanguage, message: ChatMessage) => {
  const text = getLocaleText(language)

  if (message.meta?.kind === 'log') {
    const provider = message.meta.provider as Provider | undefined
    return provider ? text.logWithProvider(getProviderLabel(language, provider)) : text.log
  }

  if (message.role === 'user') {
    return text.you
  }

  if (message.role === 'assistant') {
    const provider = message.meta?.provider as Provider | undefined
    return provider ? getProviderLabel(language, provider) : text.assistant
  }

  return text.system
}
