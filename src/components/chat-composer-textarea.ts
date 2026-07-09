const readPixelValue = (value: string) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

type CachedTextareaLayout = {
  minHeight: number
  maxHeight: number
  maxVisibleLines: number
}

const cachedTextareaLayouts = new WeakMap<HTMLTextAreaElement, CachedTextareaLayout>()

type AppliedTextareaLayout = {
  value: string
  clientWidth: number
  maxVisibleLines: number
  maxHeightStyle: string
  heightStyle: string
  overflowY: 'auto' | 'hidden'
}

const appliedTextareaLayouts = new WeakMap<HTMLTextAreaElement, AppliedTextareaLayout>()

const readCachedTextareaLayout = (
  node: HTMLTextAreaElement,
  maxVisibleLines: number,
) => {
  const cached = cachedTextareaLayouts.get(node)
  if (cached && cached.maxVisibleLines === maxVisibleLines) {
    return cached
  }

  const computed = window.getComputedStyle(node)
  const lineHeight = readPixelValue(computed.lineHeight)
  const paddingY = readPixelValue(computed.paddingTop) + readPixelValue(computed.paddingBottom)
  const minHeight = Math.max(
    readPixelValue(computed.minHeight),
    lineHeight + paddingY,
    0,
  )
  const maxHeight = Math.max(minHeight, lineHeight * maxVisibleLines + paddingY)
  const next = {
    minHeight,
    maxHeight,
    maxVisibleLines,
  }

  cachedTextareaLayouts.set(node, next)
  return next
}

export const getAutoSizedTextareaLayout = ({
  scrollHeight,
  minHeight,
  maxHeight,
}: {
  scrollHeight: number
  minHeight: number
  maxHeight: number
}) => {
  const height = Math.min(Math.max(scrollHeight, minHeight), maxHeight)

  return {
    height,
    overflowY: scrollHeight > maxHeight + 1 ? 'auto' : 'hidden',
  } as const
}

export const syncComposerTextareaHeight = (
  node: HTMLTextAreaElement | null,
  options?: {
    maxVisibleLines?: number
  },
) => {
  if (!node) {
    return
  }

  const maxVisibleLines = Math.max(options?.maxVisibleLines ?? 8, 1)
  const { minHeight, maxHeight } = readCachedTextareaLayout(node, maxVisibleLines)
  const currentValue = node.value
  const clientWidth = node.clientWidth
  const previous = appliedTextareaLayouts.get(node)

  if (
    previous &&
    previous.value === currentValue &&
    previous.clientWidth === clientWidth &&
    previous.maxVisibleLines === maxVisibleLines &&
    node.style.maxHeight === previous.maxHeightStyle &&
    node.style.height === previous.heightStyle &&
    node.style.overflowY === previous.overflowY
  ) {
    return
  }

  const nextMaxHeight = `${maxHeight}px`
  if (node.style.maxHeight !== nextMaxHeight) {
    node.style.maxHeight = nextMaxHeight
  }

  if (node.style.height !== 'auto') {
    node.style.height = 'auto'
  }

  // 空草稿不信 scrollHeight：瞬态布局（面板拖拽/隐藏期/拉伸对齐）可以让空
  // textarea 报出多行高度，而 (value, clientWidth) 记忆化会把这次误测永久锁住。
  const layout =
    currentValue === ''
      ? ({ height: minHeight, overflowY: 'hidden' } as const)
      : getAutoSizedTextareaLayout({
          scrollHeight: node.scrollHeight,
          minHeight,
          maxHeight,
        })

  const nextHeight = `${layout.height}px`
  if (node.style.height !== nextHeight) {
    node.style.height = nextHeight
  }
  if (node.style.overflowY !== layout.overflowY) {
    node.style.overflowY = layout.overflowY
  }

  appliedTextareaLayouts.set(node, {
    value: currentValue,
    clientWidth,
    maxVisibleLines,
    maxHeightStyle: nextMaxHeight,
    heightStyle: nextHeight,
    overflowY: layout.overflowY,
  })
}
