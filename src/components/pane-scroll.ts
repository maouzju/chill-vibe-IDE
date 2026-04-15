export type MessageListScrollTarget = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  dispatchEvent?: (event: Event) => unknown
}

export const syncMessageListElementToBottom = (target: MessageListScrollTarget) => {
  const nextScrollTop = Math.max(target.scrollHeight - target.clientHeight, 0)
  const shouldNotifyScrollListeners = Math.abs(target.scrollTop - nextScrollTop) > 0.5
  target.scrollTop = nextScrollTop

  if (shouldNotifyScrollListeners && typeof target.dispatchEvent === 'function') {
    target.dispatchEvent(new Event('scroll'))
  }

  return nextScrollTop
}
