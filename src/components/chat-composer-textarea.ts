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

  node.style.maxHeight = `${maxHeight}px`
  node.style.height = 'auto'

  const layout = getAutoSizedTextareaLayout({
    scrollHeight: node.scrollHeight,
    minHeight,
    maxHeight,
  })

  node.style.height = `${layout.height}px`
  node.style.overflowY = layout.overflowY
}
