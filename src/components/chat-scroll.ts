export const autoScrollBottomThresholdPx = 24
export const programmaticScrollInterruptTolerancePx = 1
export const compactHistoryAutoRevealTopThresholdPx = 72
export const restoredAnchorMaxDistanceViewports = 3.5

type MessageListMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export type CompactedHistoryAutoRevealMode = 'none' | 'near-top' | 'unscrollable'

type ScrollViewportMetrics = Pick<MessageListMetrics, 'scrollTop' | 'clientHeight'>

type ScrollChildMetrics = {
  offsetTop: number
  offsetHeight: number
}

export type ProgrammaticScrollIntent = {
  startScrollTop: number
  targetScrollTop: number
}

export const getDistanceToBottom = ({ scrollTop, scrollHeight, clientHeight }: MessageListMetrics) =>
  Math.max(scrollHeight - clientHeight - scrollTop, 0)

export const isNearMessageListBottom = (
  metrics: MessageListMetrics,
  thresholdPx = autoScrollBottomThresholdPx,
) => getDistanceToBottom(metrics) <= thresholdPx

export const getProgrammaticBottomScrollTarget = ({
  scrollHeight,
  clientHeight,
}: Pick<MessageListMetrics, 'scrollHeight' | 'clientHeight'>) => Math.max(scrollHeight - clientHeight, 0)

export type RestoredMessageListScrollPlan =
  | {
      mode: 'bottom'
      scrollTop: number
      bottomSpacerPx: 0
    }
  | {
      mode: 'anchor'
      scrollTop: number
      bottomSpacerPx: number
    }

export const getRestoredMessageListScrollPlan = ({
  scrollHeight,
  clientHeight,
  anchorScrollTop,
}: Pick<MessageListMetrics, 'scrollHeight' | 'clientHeight'> & {
  anchorScrollTop: number
}): RestoredMessageListScrollPlan => {
  const bottomScrollTop = getProgrammaticBottomScrollTarget({
    scrollHeight,
    clientHeight,
  })
  const normalizedAnchorScrollTop = Math.max(anchorScrollTop, 0)
  const requiredBottomSpacerPx = Math.max(normalizedAnchorScrollTop - bottomScrollTop, 0)
  const distanceFromBottomWhenAnchored = Math.max(bottomScrollTop - normalizedAnchorScrollTop, 0)
  const maxDistanceFromBottom = Math.max(clientHeight * restoredAnchorMaxDistanceViewports, 320)

  if (distanceFromBottomWhenAnchored > maxDistanceFromBottom) {
    return {
      mode: 'bottom',
      scrollTop: bottomScrollTop,
      bottomSpacerPx: 0,
    }
  }

  return {
    mode: 'anchor',
    scrollTop: normalizedAnchorScrollTop,
    bottomSpacerPx: requiredBottomSpacerPx,
  }
}

export const getCompactedHistoryAutoRevealMode = (
  metrics: MessageListMetrics,
  thresholdPx = compactHistoryAutoRevealTopThresholdPx,
): CompactedHistoryAutoRevealMode => {
  if (metrics.scrollHeight <= metrics.clientHeight + programmaticScrollInterruptTolerancePx) {
    return 'unscrollable'
  }

  return metrics.scrollTop <= thresholdPx ? 'near-top' : 'none'
}

export const shouldAutoRevealCompactedHistoryImmediately = (
  mode: CompactedHistoryAutoRevealMode,
) => mode !== 'none'

export const getScrollTopToRevealChild = (
  { scrollTop, clientHeight }: ScrollViewportMetrics,
  { offsetTop, offsetHeight }: ScrollChildMetrics,
) => {
  const viewportTop = Math.max(scrollTop, 0)
  const viewportBottom = viewportTop + Math.max(clientHeight, 0)
  const childTop = Math.max(offsetTop, 0)
  const childBottom = childTop + Math.max(offsetHeight, 0)

  if (childTop < viewportTop) {
    return childTop
  }

  if (childBottom > viewportBottom) {
    return Math.max(childBottom - clientHeight, 0)
  }

  return viewportTop
}

export const getScrollTopToRevealChildWithTopClearance = (
  { scrollTop, clientHeight }: ScrollViewportMetrics,
  { offsetTop, offsetHeight }: ScrollChildMetrics,
  topClearance = 0,
) => {
  const normalizedTopClearance = Math.max(topClearance, 0)
  const viewportTop = Math.max(scrollTop, 0)
  const viewportBottom = viewportTop + Math.max(clientHeight, 0)
  const visibleTop = viewportTop + normalizedTopClearance
  const childTop = Math.max(offsetTop, 0)
  const childBottom = childTop + Math.max(offsetHeight, 0)

  if (childTop < visibleTop) {
    return Math.max(childTop - normalizedTopClearance, 0)
  }

  if (childBottom > viewportBottom) {
    return Math.max(childBottom - clientHeight, 0)
  }

  return viewportTop
}

export const didUserInterruptProgrammaticScroll = (
  intent: ProgrammaticScrollIntent,
  currentScrollTop: number,
  tolerancePx = programmaticScrollInterruptTolerancePx,
) => {
  if (intent.targetScrollTop > intent.startScrollTop) {
    return currentScrollTop < intent.startScrollTop - tolerancePx
  }

  if (intent.targetScrollTop < intent.startScrollTop) {
    return currentScrollTop > intent.startScrollTop + tolerancePx
  }

  return false
}

export const getAutoScrollStateDuringProgrammaticScroll = (
  intent: ProgrammaticScrollIntent | null,
  currentScrollTop: number,
  previousShouldAutoScroll: boolean,
  tolerancePx = programmaticScrollInterruptTolerancePx,
) => {
  const interrupted = intent
    ? didUserInterruptProgrammaticScroll(intent, currentScrollTop, tolerancePx)
    : false

  return {
    interrupted,
    shouldAutoScroll: interrupted ? false : previousShouldAutoScroll,
    lastScrollTop: currentScrollTop,
  }
}

export const getAutoScrollStateAfterUserScroll = (
  previousScrollTop: number,
  metrics: MessageListMetrics,
  thresholdPx = autoScrollBottomThresholdPx,
) => {
  const currentBottomScrollTop = getProgrammaticBottomScrollTarget(metrics)

  if (metrics.scrollTop < previousScrollTop) {
    if (
      previousScrollTop > currentBottomScrollTop + programmaticScrollInterruptTolerancePx &&
      Math.abs(metrics.scrollTop - currentBottomScrollTop) <= programmaticScrollInterruptTolerancePx
    ) {
      return {
        shouldAutoScroll: true,
        lastScrollTop: metrics.scrollTop,
      }
    }

    return {
      shouldAutoScroll: false,
      lastScrollTop: metrics.scrollTop,
    }
  }

  return {
    shouldAutoScroll: isNearMessageListBottom(metrics, thresholdPx),
    lastScrollTop: metrics.scrollTop,
  }
}

// Async content growth (images/code highlight/mermaid finishing layout after
// the stream closed, or tab visibility changes flushing deferred work) can push
// the real bottom below the pinned scrollTop. The scroll handler will not fire
// because scrollTop itself did not change, so the useLayoutEffect dependency
// graph never sees the delta. This predicate decides whether the auto-scroll
// loop should re-pin to the new bottom based only on the measurable invariants:
// the list really grew, and the user was at the bottom before the growth.
export const shouldPinToBottomAfterContentGrowth = ({
  previousBottomScrollTop,
  currentMetrics,
  wasPinned,
  tolerancePx = programmaticScrollInterruptTolerancePx,
}: {
  previousBottomScrollTop: number
  currentMetrics: MessageListMetrics
  wasPinned: boolean
  tolerancePx?: number
}) => {
  if (!wasPinned) {
    return false
  }

  const currentBottomScrollTop = getProgrammaticBottomScrollTarget(currentMetrics)
  if (currentBottomScrollTop <= previousBottomScrollTop + tolerancePx) {
    return false
  }

  return Math.abs(currentMetrics.scrollTop - previousBottomScrollTop) <= tolerancePx
}

export const didHiddenLayoutClampScrollToTop = ({
  previousScrollTop,
  currentScrollTop,
  previousClientHeight,
  currentClientHeight,
  previousScrollHeight,
  currentScrollHeight,
  tolerancePx = programmaticScrollInterruptTolerancePx,
}: {
  previousScrollTop: number
  currentScrollTop: number
  previousClientHeight: number
  currentClientHeight: number
  previousScrollHeight: number
  currentScrollHeight: number
  tolerancePx?: number
}) =>
  previousScrollTop > tolerancePx &&
  currentScrollTop <= tolerancePx &&
  previousClientHeight > tolerancePx &&
  currentClientHeight <= tolerancePx &&
  previousScrollHeight > previousClientHeight + tolerancePx &&
  currentScrollHeight <= currentClientHeight + tolerancePx

export const shouldIgnoreHiddenLayoutScrollReset = ({
  previousScrollTop,
  currentMetrics,
  previousMetrics,
  isVisible,
  tolerancePx = programmaticScrollInterruptTolerancePx,
}: {
  previousScrollTop: number
  currentMetrics: MessageListMetrics
  previousMetrics?: Pick<MessageListMetrics, 'scrollHeight' | 'clientHeight'> | null
  isVisible: boolean
  tolerancePx?: number
}) =>
  !isVisible &&
  previousScrollTop > tolerancePx &&
  currentMetrics.scrollTop <= tolerancePx &&
  (!previousMetrics ||
    didHiddenLayoutClampScrollToTop({
      previousScrollTop,
      currentScrollTop: currentMetrics.scrollTop,
      previousClientHeight: previousMetrics.clientHeight,
      currentClientHeight: currentMetrics.clientHeight,
      previousScrollHeight: previousMetrics.scrollHeight,
      currentScrollHeight: currentMetrics.scrollHeight,
      tolerancePx,
    }) ||
    currentMetrics.clientHeight > tolerancePx)

export const getAutoScrollStateAfterObservedScroll = ({
  previousScrollTop,
  currentMetrics,
  previousMetrics,
  previousShouldAutoScroll,
  isVisible,
  thresholdPx = autoScrollBottomThresholdPx,
}: {
  previousScrollTop: number
  currentMetrics: MessageListMetrics
  previousMetrics?: Pick<MessageListMetrics, 'scrollHeight' | 'clientHeight'> | null
  previousShouldAutoScroll: boolean
  isVisible: boolean
  thresholdPx?: number
}) => {
  if (
    shouldIgnoreHiddenLayoutScrollReset({
      previousScrollTop,
      currentMetrics,
      previousMetrics,
      isVisible,
    })
  ) {
    return {
      shouldAutoScroll: previousShouldAutoScroll,
      lastScrollTop: previousScrollTop,
      ignored: true,
    }
  }

  return {
    ...getAutoScrollStateAfterUserScroll(previousScrollTop, currentMetrics, thresholdPx),
    ignored: false,
  }
}

export const getAutoScrollStateAfterCardUpdate = ({
  previousCardId,
  currentCardId,
  previousShouldAutoScroll,
  shouldStartPinnedToBottom,
  isRestoredAnchorLocked,
}: {
  previousCardId: string
  currentCardId: string
  previousShouldAutoScroll: boolean
  shouldStartPinnedToBottom: boolean
  isRestoredAnchorLocked: boolean
}) => {
  if (isRestoredAnchorLocked) {
    return false
  }

  if (previousCardId !== currentCardId) {
    return shouldStartPinnedToBottom
  }

  return previousShouldAutoScroll
}
