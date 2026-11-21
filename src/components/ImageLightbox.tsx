import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'

import { ChevronDownIcon, CloseIcon, CopyIcon } from './Icons'
import { useDialogFocus } from './dialog-focus'
import {
  clampView,
  collectSiblingLightboxImages,
  getDoubleClickScale,
  getFitScale,
  getFitView,
  getWheelZoomFactor,
  wrapLightboxIndex,
  zoomViewAt,
  type LightboxSize,
  type LightboxView,
} from './image-lightbox-math'

export type LightboxImage = { src: string; alt: string }

const isChineseUi = () =>
  typeof document === 'undefined' || !document.documentElement.lang.toLowerCase().startsWith('en')

const getLightboxText = () => isChineseUi()
  ? {
      dialog: '查看图片',
      close: '关闭（Esc）',
      prev: '上一张（←）',
      next: '下一张（→）',
      zoomIn: '放大（+）',
      zoomOut: '缩小（-）',
      fit: '适应窗口（0）',
      actual: '原始大小（1）',
      copy: '复制图片',
      copied: '已复制',
      copyFailed: '复制失败',
      hint: '滚轮缩放 · 拖动平移 · 双击切换',
    }
  : {
      dialog: 'View image',
      close: 'Close (Esc)',
      prev: 'Previous (←)',
      next: 'Next (→)',
      zoomIn: 'Zoom in (+)',
      zoomOut: 'Zoom out (-)',
      fit: 'Fit to window (0)',
      actual: 'Actual size (1)',
      copy: 'Copy image',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      hint: 'Scroll to zoom · drag to pan · double-click to toggle',
    }

const copyImageToClipboard = async (src: string) => {
  const response = await fetch(src)
  const blob = await response.blob()
  if (blob.type === 'image/png') {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return
  }
  // 剪贴板只稳定支持 PNG：其它格式先画到 canvas 再转。走 blob 解码，不会被跨源污染。
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('encode failed'))), 'image/png')
  })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

const ZOOM_STEP = 1.25
const DRAG_THRESHOLD_PX = 4
const FIT_INSET_X = 72
const FIT_INSET_Y = 88

export const ImageLightbox = ({
  images,
  initialIndex,
  onClose,
}: {
  images: LightboxImage[]
  initialIndex: number
  onClose: () => void
}) => {
  const text = getLightboxText()
  const dialogRef = useDialogFocus<HTMLDivElement>({ isOpen: true, onClose })
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [index, setIndex] = useState(() => wrapLightboxIndex(initialIndex, images.length))
  // 尺寸、用户视图、复制提示都按图片 src 记：换图后自然失效，不用在 effect 里手动清空。
  const [loaded, setLoaded] = useState<{ src: string; size: LightboxSize } | null>(null)
  const [viewport, setViewport] = useState<LightboxSize>({ width: 0, height: 0 })
  const [userView, setUserView] = useState<{ src: string; view: LightboxView } | null>(null)
  const [animate, setAnimate] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [copyResult, setCopyResult] = useState<{ src: string; state: 'copied' | 'failed' } | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null>(null)
  const suppressClickRef = useRef(false)

  const current = images[index]
  const currentSrc = current?.src ?? ''
  const count = images.length
  const natural = loaded && loaded.src === currentSrc ? loaded.size : null
  // 适应窗口时给上方标题栏、下方工具条和左右切换键留出空间，图不被控件压住。
  const fitArea = useMemo(() => ({
    width: Math.max(1, viewport.width - FIT_INSET_X * 2),
    height: Math.max(1, viewport.height - FIT_INSET_Y * 2),
  }), [viewport])
  const resolveView = useCallback((entry: { src: string; view: LightboxView } | null): LightboxView => {
    if (!natural) return { scale: 1, x: 0, y: 0 }
    // 没手动缩放过 = 适应窗口；窗口尺寸变了也只重新夹紧，不重置用户的缩放。
    return clampView(entry && entry.src === currentSrc ? entry.view : getFitView(natural, fitArea), natural, viewport)
  }, [natural, viewport, currentSrc, fitArea])
  const view = resolveView(userView)
  const copyState = copyResult && copyResult.src === currentSrc ? copyResult.state : 'idle'
  const viewRef = useRef(view)
  useLayoutEffect(() => {
    viewRef.current = view
  }, [view])

  const updateView = useCallback((update: (value: LightboxView) => LightboxView) => {
    if (!natural) return
    setUserView((previous) => ({ src: currentSrc, view: update(resolveView(previous)) }))
  }, [natural, currentSrc, resolveView])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => setViewport({ width: stage.clientWidth, height: stage.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const fitScale = natural ? getFitScale(natural, fitArea) : 1

  const zoomTo = useCallback((nextScale: number, anchor = { x: 0, y: 0 }, smooth = true) => {
    if (!natural) return
    setAnimate(smooth)
    updateView((value) => zoomViewAt(value, nextScale, anchor, natural, viewport))
  }, [natural, viewport, updateView])

  const resetToFit = useCallback(() => {
    if (!natural) return
    setAnimate(true)
    setUserView(null)
  }, [natural])

  const go = useCallback((delta: number) => {
    if (count > 1) setIndex((value) => wrapLightboxIndex(value + delta, count))
  }, [count])

  const anchorFromClient = (clientX: number, clientY: number) => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
  }

  // React 的 onWheel 是 passive，拦不住页面滚动，所以手挂原生监听。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!natural) return
      const rect = stage.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
      setAnimate(false)
      updateView((value) => zoomViewAt(
        value,
        value.scale * getWheelZoomFactor(event.deltaY, event.deltaMode),
        anchor,
        natural,
        viewport,
      ))
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  }, [natural, viewport, updateView])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      switch (event.key) {
        case 'ArrowLeft': go(-1); break
        case 'ArrowRight': go(1); break
        case '+': case '=': zoomTo(viewRef.current.scale * ZOOM_STEP); break
        case '-': case '_': zoomTo(viewRef.current.scale / ZOOM_STEP); break
        case '0': resetToFit(); break
        case '1': zoomTo(1); break
        default: return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [go, zoomTo, resetToFit])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: viewRef.current.x,
      viewY: viewRef.current.y,
      moved: false,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !natural) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
    if (!drag.moved) {
      drag.moved = true
      setDragging(true)
      setAnimate(false)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    updateView((value) => clampView({ ...value, x: drag.viewX + dx, y: drag.viewY + dy }, natural, viewport))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    suppressClickRef.current = drag.moved
    dragRef.current = null
    setDragging(false)
  }

  // 点空白处关闭；拖动松手、点在图上都不关。
  const handleStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    if (event.target === event.currentTarget) onClose()
  }

  const handleDoubleClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    zoomTo(getDoubleClickScale(viewRef.current.scale, fitScale), anchorFromClient(event.clientX, event.clientY))
  }

  const handleCopy = async () => {
    if (!current) return
    try {
      await copyImageToClipboard(current.src)
      setCopyResult({ src: current.src, state: 'copied' })
    } catch {
      setCopyResult({ src: current.src, state: 'failed' })
    }
  }

  useEffect(() => {
    if (!copyResult) return
    const timer = window.setTimeout(() => setCopyResult(null), 1600)
    return () => window.clearTimeout(timer)
  }, [copyResult])

  if (!current) return null

  const zoomed = view.scale > fitScale + 0.001
  const percent = Math.round(view.scale * 100)
  const layer = (
    <div
      ref={dialogRef}
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={text.dialog}
      tabIndex={-1}
    >
      <div className="image-lightbox-topbar">
        <div className="image-lightbox-title" title={current.alt}>
          {count > 1 ? <span className="image-lightbox-counter">{index + 1} / {count}</span> : null}
          {current.alt ? <span className="image-lightbox-name">{current.alt}</span> : null}
        </div>
        <button type="button" className="image-lightbox-icon-btn image-lightbox-close" onClick={onClose} aria-label={text.close} title={text.close}>
          <CloseIcon />
        </button>
      </div>

      <div
        ref={stageRef}
        className={`image-lightbox-stage${dragging ? ' is-dragging' : ''}${zoomed ? ' is-zoomed' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleStageClick}
      >
        <img
          key={current.src}
          className={`image-lightbox-image${animate ? ' is-animated' : ''}${natural ? '' : ' is-loading'}`}
          src={current.src}
          alt={current.alt}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget
            setAnimate(false)
            setLoaded({ src: current.src, size: { width: image.naturalWidth || 1, height: image.naturalHeight || 1 } })
          }}
          onDoubleClick={handleDoubleClick}
          style={natural ? {
            width: natural.width,
            height: natural.height,
            transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          } : undefined}
        />
      </div>

      {count > 1 ? (
        <>
          <button type="button" className="image-lightbox-icon-btn image-lightbox-nav is-prev" onClick={() => go(-1)} aria-label={text.prev} title={text.prev}>
            <ChevronDownIcon />
          </button>
          <button type="button" className="image-lightbox-icon-btn image-lightbox-nav is-next" onClick={() => go(1)} aria-label={text.next} title={text.next}>
            <ChevronDownIcon />
          </button>
        </>
      ) : null}

      <div className="image-lightbox-toolbar" role="toolbar">
        <button type="button" className="image-lightbox-tool" onClick={() => zoomTo(view.scale / ZOOM_STEP)} aria-label={text.zoomOut} title={text.zoomOut}>−</button>
        <button type="button" className="image-lightbox-tool image-lightbox-percent" onClick={resetToFit} title={text.fit}>{percent}%</button>
        <button type="button" className="image-lightbox-tool" onClick={() => zoomTo(view.scale * ZOOM_STEP)} aria-label={text.zoomIn} title={text.zoomIn}>+</button>
        <span className="image-lightbox-divider" aria-hidden="true" />
        <button type="button" className="image-lightbox-tool is-text" onClick={resetToFit} title={text.fit}>{isChineseUi() ? '适应' : 'Fit'}</button>
        <button type="button" className="image-lightbox-tool is-text" onClick={() => zoomTo(1)} title={text.actual}>1:1</button>
        <span className="image-lightbox-divider" aria-hidden="true" />
        <button type="button" className="image-lightbox-tool is-text image-lightbox-copy" onClick={() => void handleCopy()} title={text.copy}>
          <CopyIcon />
          <span>{copyState === 'copied' ? text.copied : copyState === 'failed' ? text.copyFailed : text.copy}</span>
        </button>
      </div>
      <div className="image-lightbox-hint">{text.hint}</div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(layer, document.body) : layer
}

// 会话里 AI 贴的图：单击直接打开看图器（滚轮缩放/拖动/左右切换同一条消息里的图）。
// 图被包在链接里时也优先看图，否则点图会跳走，想放大就得另找入口。
export const MarkdownZoomableImage = (props: ComponentProps<'img'>) => {
  const [lightbox, setLightbox] = useState<{ images: LightboxImage[]; index: number } | null>(null)
  const { className, onClick, ...rest } = props
  return (
    <>
      <img
        {...rest}
        className={className ? `${className} message-zoomable-image` : 'message-zoomable-image'}
        onClick={(event) => {
          onClick?.(event)
          if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return
          event.preventDefault()
          event.stopPropagation()
          setLightbox(collectSiblingLightboxImages(event.currentTarget))
        }}
      />
      {lightbox ? (
        <ImageLightbox images={lightbox.images} initialIndex={lightbox.index} onClose={() => setLightbox(null)} />
      ) : null}
    </>
  )
}
