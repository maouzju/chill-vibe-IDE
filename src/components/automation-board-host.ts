import type {
  AutomationBoardAutoTrigger,
  AutomationBoardLane,
  AutomationBoardTemplate,
  ChatCard,
} from '../../shared/schema'
import type { AutomationBoardTabDropSource } from './AutomationBoardCard'

/**
 * App 层的看板动作集合，一次性往下传，避免给 PaneView / ChatCard 各加二十个
 * prop。每个 handler 都显式收 columnId / boardCardId，因为一列里可以有多张
 * 看板，且看板项与看板必须同列（cwd 由列的 workspacePath 决定）。
 *
 * 所有实际副作用都在 App 里走既有 handler（sendMessage / requestStopForCard /
 * applyAction），这里只是转发口 —— 与手机监工写命令同一条规矩。
 */
export type AutomationBoardActions = {
  createItem: (
    columnId: string,
    boardCardId: string,
    lane: AutomationBoardLane,
    requirement: string,
    index?: number,
  ) => void
  moveItem: (
    columnId: string,
    boardCardId: string,
    cardId: string,
    lane: AutomationBoardLane,
    index?: number,
  ) => void
  popOutItem: (
    columnId: string,
    boardCardId: string,
    cardId: string,
    paneId: string,
    index?: number,
  ) => void
  absorbTab: (
    columnId: string,
    boardCardId: string,
    source: AutomationBoardTabDropSource,
    lane: AutomationBoardLane,
    index?: number,
  ) => void
  instantiateTemplate: (
    columnId: string,
    boardCardId: string,
    templateId: string,
    lane: AutomationBoardLane,
    index?: number,
  ) => void
  deleteItem: (columnId: string, boardCardId: string, cardId: string) => void
  saveTemplate: (columnId: string, boardCardId: string, cardId: string) => void
  renameTemplate: (workspacePath: string, templateId: string, name: string) => void
  deleteTemplate: (workspacePath: string, templateId: string) => void
  stopItem: (cardId: string) => void
  sendToItem: (columnId: string, cardId: string, message: string) => void
  patchItemCard: (columnId: string, cardId: string, patch: Partial<ChatCard>) => void
  updateAutoTrigger: (workspacePath: string, patch: Partial<AutomationBoardAutoTrigger>) => void
  runSupervisorNow: (columnId: string, boardCardId: string) => void
  setSupervisorExpanded: (columnId: string, boardCardId: string, expanded: boolean) => void
}

export type AutomationBoardWorkspaceView = {
  templates: AutomationBoardTemplate[]
  autoTrigger: AutomationBoardAutoTrigger
}
