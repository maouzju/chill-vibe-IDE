import type { AppLanguage } from '../../shared/schema'

export const getFileTreeCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading files...' : '加载文件中...',
  searchPlaceholder: language === 'en' ? 'Search files' : '搜索文件',
  searchLabel: language === 'en' ? 'Search files' : '搜索文件',
  clearSearch: language === 'en' ? 'Clear' : '清除',
  searching: language === 'en' ? 'Searching files...' : '搜索文件中...',
  emptySearch: language === 'en' ? 'No files match this search.' : '没有找到匹配的文件。',
})

export const getTextEditorCardText = (language: AppLanguage) => ({
  loading: language === 'en' ? 'Loading...' : '加载中...',
  saving: language === 'en' ? 'Saving...' : '保存中...',
  unsaved: language === 'en' ? 'Unsaved' : '未保存',
})

export const getSpecToolText = (language: AppLanguage) => ({
  emptyTitle: language === 'en' ? 'New SPEC' : '新 SPEC',
  titleLabel: language === 'en' ? 'Feature title' : '功能标题',
  titlePlaceholder: language === 'en' ? 'Name the feature or initiative' : '填写功能名或专项名',
  startButton: language === 'en' ? 'Create SPEC scaffold' : '生成 SPEC 骨架',
  creating: language === 'en' ? 'Creating…' : '生成中…',
  docsReady:
    language === 'en'
      ? 'SPEC docs are ready. Review them before writing production code.'
      : 'SPEC 文档已就位，可以先 review 再写代码。',
  requirementsLabel: language === 'en' ? 'Requirements' : '需求',
  designLabel: language === 'en' ? 'Design' : '设计',
  tasksLabel: language === 'en' ? 'Tasks' : '任务',
  openRequirements: language === 'en' ? 'Open requirements' : '打开需求',
  openDesign: language === 'en' ? 'Open design' : '打开设计',
  openTasks: language === 'en' ? 'Open tasks' : '打开任务',
  launchAgent: language === 'en' ? 'Send to agent' : '交给 Agent',
  launchHint:
    language === 'en'
      ? 'This sends a SPEC-first prompt so the agent works from docs before code.'
      : '这会发一条 SPEC-first 指令，让 Agent 先文档后代码。',
  missingWorkspace:
    language === 'en'
      ? 'Open a workspace first so SPEC files can be created inside it.'
      : '请先打开工作区，才能把 SPEC 文档落到项目里。',
  genericError:
    language === 'en'
      ? 'Unable to create the SPEC scaffold right now.'
      : '暂时无法生成 SPEC 骨架。',
})
