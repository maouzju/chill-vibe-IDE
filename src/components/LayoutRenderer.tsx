import type {
  AutoUrgeProfile,
  BoardColumn,
  ImageAttachment,
  LayoutNode,
  ModelPromptRule,
  Provider,
  ProviderStatus,
} from '../../shared/schema'
import type { AppLanguage } from '../../shared/schema'
import type { CardRecoveryStatus } from '../stream-recovery-feedback'
import type { QueuedSendSummary, SendMessageOptions } from './deferred-send-queue'
import { PaneView } from './PaneView'
import { SplitResizeHandle } from './SplitResizeHandle'

type LayoutRendererProps = {
  column: BoardColumn
  node: LayoutNode
  providers: Record<string, ProviderStatus>
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  crossProviderSkillReuseEnabled: boolean
  musicAlbumCoverEnabled: boolean
  weatherCity: string
  gitAgentModel: string
  brainstormRequestModel: string
  availableQuickToolModels: string[]
  autoUrgeEnabled: boolean
  autoUrgeProfiles?: AutoUrgeProfile[]
  autoUrgeMessage: string
  autoUrgeSuccessKeyword: string
  onSetAutoUrgeEnabled: (enabled: boolean) => void
  flashCardIds: Set<string>
  onRestoredAnimationEnd: (cardId: string) => void
  onAddTab: (paneId: string) => void
  onSplitPane: (
    paneId: string,
    direction: 'horizontal' | 'vertical',
    placement?: 'before' | 'after',
    tabId?: string,
    newPaneId?: string,
  ) => void
  onSplitMoveTab: (
    sourcePaneId: string,
    targetPaneId: string,
    tabId: string,
    direction: 'horizontal' | 'vertical',
    placement: 'before' | 'after',
    newPaneId: string,
  ) => void
  onCloseTab: (paneId: string, tabId: string) => void
  onMoveTab: (
    sourceColumnId: string,
    sourcePaneId: string,
    tabId: string,
    targetColumnId: string,
    targetPaneId: string,
    index?: number,
  ) => void
  onReorderTab: (paneId: string, tabId: string, index: number) => void
  onSetActiveTab: (paneId: string, tabId: string) => void
  onResizePane: (splitId: string, ratios: number[]) => void
  onActivatePane: (paneId: string) => void
  onChangeCardModel: (cardId: string, provider: Provider, model: string) => void
  onChangeCardReasoningEffort: (cardId: string, reasoningEffort: string) => void
  onToggleCardPlanMode: (cardId: string) => void
  onToggleCardThinking: (cardId: string) => void
  onToggleCardCollapsed: (cardId: string) => void
  onMarkCardRead: (cardId: string) => void
  onChangeCardDraft: (cardId: string, draft: string) => void
  onChangeCardStickyNote: (cardId: string, content: string) => void
  onPatchCard: (
    cardId: string,
    patch: Partial<
      Pick<
        BoardColumn['cards'][string],
        | 'status'
        | 'sessionId'
        | 'brainstorm'
        | 'autoUrgeActive'
        | 'autoUrgeProfileId'
      >
    >,
  ) => void
  onChangeCardTitle: (cardId: string, title: string) => void
  onSendMessage: (
    cardId: string,
    prompt: string,
    attachments: ImageAttachment[],
    options?: SendMessageOptions,
  ) => Promise<void>
  onStopMessage: (cardId: string) => Promise<void>
  onCancelQueuedSends?: (cardId: string) => void
  onSendNextQueuedNow?: (cardId: string) => void
  onManualRecoverStream?: (cardId: string) => Promise<unknown>
  onForkConversation?: (cardId: string, messageId: string) => void
  onOpenFile?: (paneId: string, relativePath: string) => void
  cardRecoveryStatuses?: ReadonlyMap<string, CardRecoveryStatus>
  queuedSendSummaries?: ReadonlyMap<string, QueuedSendSummary>
}

export const LayoutRenderer = ({
  column,
  node,
  onResizePane,
  ...props
}: LayoutRendererProps) => {
  if (node.type === 'split') {
    return (
      <div className="split-container" data-direction={node.direction}>
        {node.children.map((child, index) => [
          <div key={child.id} className="split-child" style={{ flex: node.ratios[index] ?? 1 }}>
            <LayoutRenderer
              {...props}
              column={column}
              node={child}
              onResizePane={onResizePane}
            />
          </div>,
          index < node.children.length - 1 ? (
            <SplitResizeHandle
              key={`${node.id}-handle-${child.id}`}
              direction={node.direction}
              splitId={node.id}
              index={index}
              ratios={node.ratios}
              onResize={onResizePane}
            />
          ) : null,
        ])}
      </div>
    )
  }

  return (
    <PaneView
      {...props}
      column={column}
      pane={node}
    />
  )
}
