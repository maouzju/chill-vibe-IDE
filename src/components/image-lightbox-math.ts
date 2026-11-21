// 会话看图器的纯几何：视图 = 缩放倍数 + 图片中心相对视口中心的位移（像素）。
// 拆成纯函数是为了能在 node --test 里验证「以光标为锚点缩放」「拖不丢图」这两条最容易回归的手感。

export type LightboxSize = { width: number; height: number }
export type LightboxView = { scale: number; x: number; y: number }

export const LIGHTBOX_MAX_SCALE = 16

// 适应窗口：大图缩到放得下，小图保持原尺寸（不糊成马赛克）。
export const getFitScale = (natural: LightboxSize, viewport: LightboxSize) => {
  if (natural.width <= 0 || natural.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return 1
  }
  return Math.min(1, viewport.width / natural.width, viewport.height / natural.height)
}

export const getMinScale = (fitScale: number) => Math.min(fitScale * 0.5, 0.1)

const clampAxis = (offset: number, scaledLength: number, viewportLength: number) => {
  // 图比视口窄时居中；比视口宽时只允许拖到图边贴住视口边，不会把图拖丢。
  if (scaledLength <= viewportLength) return 0
  const limit = (scaledLength - viewportLength) / 2
  return Math.max(-limit, Math.min(limit, offset))
}

export const clampView = (
  view: LightboxView,
  natural: LightboxSize,
  viewport: LightboxSize,
): LightboxView => {
  const fit = getFitScale(natural, viewport)
  const scale = Math.max(getMinScale(fit), Math.min(LIGHTBOX_MAX_SCALE, view.scale))
  return {
    scale,
    x: clampAxis(view.x, natural.width * scale, viewport.width),
    y: clampAxis(view.y, natural.height * scale, viewport.height),
  }
}

// anchor 是相对视口中心的坐标：缩放后锚点下方仍是同一个图片像素。
export const zoomViewAt = (
  view: LightboxView,
  nextScale: number,
  anchor: { x: number; y: number },
  natural: LightboxSize,
  viewport: LightboxSize,
): LightboxView => {
  const fit = getFitScale(natural, viewport)
  const scale = Math.max(getMinScale(fit), Math.min(LIGHTBOX_MAX_SCALE, nextScale))
  const ratio = scale / view.scale
  return clampView(
    {
      scale,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    natural,
    viewport,
  )
}

export const getFitView = (natural: LightboxSize, viewport: LightboxSize): LightboxView => ({
  scale: getFitScale(natural, viewport),
  x: 0,
  y: 0,
})

// 双击：没放大时放到 1:1（原图已经放得下就放到 2 倍），已放大时回到适应窗口。
export const getDoubleClickScale = (current: number, fitScale: number) => {
  if (current > fitScale + 0.001) return fitScale
  return fitScale < 0.999 ? 1 : Math.min(LIGHTBOX_MAX_SCALE, fitScale * 2)
}

export const getWheelZoomFactor = (deltaY: number, deltaMode = 0) => {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY
  return Math.exp(-Math.max(-300, Math.min(300, pixels)) * 0.0018)
}

export const wrapLightboxIndex = (index: number, count: number) =>
  count <= 0 ? 0 : ((index % count) + count) % count

// 点消息里任意一张图：把同一条消息里的图都收进来，可左右切换。
export const collectSiblingLightboxImages = (target: HTMLImageElement): { images: { src: string; alt: string }[]; index: number } => {
  const scope = target.closest('.message-content, .message-attachment-list') ?? target.parentElement
  const nodes = scope
    ? Array.from(scope.querySelectorAll<HTMLImageElement>('img')).filter((node) => node.currentSrc || node.src)
    : [target]
  const list = nodes.includes(target) ? nodes : [target]
  return {
    images: list.map((node) => ({ src: node.currentSrc || node.src, alt: node.alt })),
    index: Math.max(0, list.indexOf(target)),
  }
}
