import type { ChatCard as ChatCardState } from '../../shared/schema'
import {
  BotIcon,
  ChartIcon,
  ClaudeIcon,
  CloudIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GptIcon,
  HeadphonesIcon,
  ImageIcon,
  KanbanIcon,
  NeteaseCloudMusicIcon,
  SparklesIcon,
  StickyNoteIcon,
} from './Icons'
import {
  AUTOMATIONBOARD_TOOL_MODEL,
  BRAINSTORM_TOOL_MODEL,
  FILETREE_TOOL_MODEL,
  GIT_TOOL_MODEL,
  IMAGEEDITOR_TOOL_MODEL,
  MUSIC_TOOL_MODEL,
  STATS_TOOL_MODEL,
  STICKYNOTE_TOOL_MODEL,
  TEXTEDITOR_TOOL_MODEL,
  WEATHER_TOOL_MODEL,
  WHITENOISE_TOOL_MODEL,
} from '../../shared/models'

export const getPaneTabIcon = (card: ChatCardState) => {
  if (card.model === GIT_TOOL_MODEL) {
    return <GitBranchIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === MUSIC_TOOL_MODEL) {
    return <NeteaseCloudMusicIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === WHITENOISE_TOOL_MODEL) {
    return <HeadphonesIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === WEATHER_TOOL_MODEL) {
    return <CloudIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === STICKYNOTE_TOOL_MODEL) {
    return <StickyNoteIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === FILETREE_TOOL_MODEL) {
    return <FolderIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === BRAINSTORM_TOOL_MODEL) {
    return <SparklesIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === TEXTEDITOR_TOOL_MODEL) {
    return <FileTextIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === IMAGEEDITOR_TOOL_MODEL) {
    return <ImageIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === AUTOMATIONBOARD_TOOL_MODEL) {
    return <KanbanIcon className="pane-tab-icon" aria-hidden="true" />
  }

  if (card.model === STATS_TOOL_MODEL) {
    return <ChartIcon className="pane-tab-icon" aria-hidden="true" />
  }

  // agent 派发的会话优先于 provider 图标：用户要一眼分清「我开的」和「agent 替我开的」。
  if (card.spawnedByAgent === true) {
    return <BotIcon className="pane-tab-icon pane-tab-icon--bot" aria-hidden="true" />
  }

  if (card.provider === 'claude') {
    return <ClaudeIcon className="pane-tab-icon" aria-hidden="true" />
  }

  return <GptIcon className="pane-tab-icon" aria-hidden="true" />
}
