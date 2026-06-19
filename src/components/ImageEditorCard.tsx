import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchFileContent } from '../api'
import type { AppLanguage } from '../../shared/schema'
import { getImageFileMimeType } from './image-file-routing'

type ImageEditorCardProps = {
  workspacePath: string
  filePath: string
  language: AppLanguage
}

type CropState = { top: number; right: number; bottom: number; left: number }

type AdjustState = { brightness: number; contrast: number; saturation: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const labels = (language: AppLanguage) => language === 'zh-CN'
  ? {
      loading: '???????',
      unsupported: '?????????????',
      binaryUnavailable: '?????????',
      tooLarge: '??????????????',
      reset: '??',
      fit: '??',
      actual: '100%',
      export: '?? PNG',
      rotateLeft: '??',
      rotateRight: '??',
      flipH: '????',
      flipV: '????',
      crop: '??',
      adjust: '??',
      brightness: '??',
      contrast: '??',
      saturation: '??',
      top: '?',
      right: '?',
      bottom: '?',
      left: '?',
      zoomOut: '??',
      zoomIn: '??',
    }
  : {
      loading: 'Opening image?',
      unsupported: 'This image format is not supported yet.',
      binaryUnavailable: 'Unable to read image content.',
      tooLarge: 'Image is too large to preview in the card.',
      reset: 'Reset',
      fit: 'Fit',
      actual: '100%',
      export: 'Export PNG',
      rotateLeft: 'Rotate left',
      rotateRight: 'Rotate right',
      flipH: 'Flip H',
      flipV: 'Flip V',
      crop: 'Crop',
      adjust: 'Adjust',
      brightness: 'Brightness',
      contrast: 'Contrast',
      saturation: 'Saturation',
      top: 'Top',
      right: 'Right',
      bottom: 'Bottom',
      left: 'Left',
      zoomOut: 'Zoom out',
      zoomIn: 'Zoom in',
    }

const binaryStringToBase64 = (value: string) => {
  let binary = ''
  for (let index = 0; index < value.length; index += 1) {
    binary += String.fromCharCode(value.charCodeAt(index) & 0xff)
  }
  return btoa(binary)
}

const loadImageElement = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(new Error('Unable to decode image.'))
  image.src = src
})

export const ImageEditorCard = ({ workspacePath, filePath, language }: ImageEditorCardProps) => {
  const text = labels(language)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState<number | null>(null)
  const [zoom, setZoom] = useState(0.85)
  const [rotation, setRotation] = useState(0)
  const [flipX, setFlipX] = useState(false)
  const [flipY, setFlipY] = useState(false)
  const [crop, setCrop] = useState<CropState>({ top: 0, right: 0, bottom: 0, left: 0 })
  const [adjust, setAdjust] = useState<AdjustState>({ brightness: 100, contrast: 100, saturation: 100 })

  const mimeType = useMemo(() => getImageFileMimeType(filePath), [filePath])
  const isSvg = mimeType === 'image/svg+xml'

  useEffect(() => {
    let cancelled = false
    let objectUrl = ''

    const run = async () => {
      await Promise.resolve()
      if (cancelled) return
      setLoading(true)
      setError(null)
      setSourceImage(null)
      setSourceUrl('')
      setSize(null)

      if (!mimeType) {
        throw new Error(text.unsupported)
      }

      const response = await fetchFileContent(workspacePath, filePath)
      setSize(response.size ?? null)

      if (response.tooLarge) {
        throw new Error(text.tooLarge)
      }

      let url = ''
      if (isSvg) {
        url = `data:${mimeType};charset=utf-8,${encodeURIComponent(response.content)}`
      } else if (response.dataBase64) {
        url = `data:${response.mimeType ?? mimeType};base64,${response.dataBase64}`
      } else if (response.binary && response.content.length === 0) {
        throw new Error(text.binaryUnavailable)
      } else {
        url = `data:${mimeType};base64,${binaryStringToBase64(response.content)}`
      }

      const image = await loadImageElement(url)
      if (cancelled) return
      objectUrl = url
      setSourceUrl(url)
      setSourceImage(image)
    }

    run().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
      if (objectUrl.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
    }
  }, [filePath, isSvg, mimeType, text.binaryUnavailable, text.tooLarge, text.unsupported, workspacePath])

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const image = sourceImage
    if (!canvas || !image) return

    const cropLeft = clamp(crop.left, 0, image.naturalWidth - 1)
    const cropRight = clamp(crop.right, 0, image.naturalWidth - cropLeft - 1)
    const cropTop = clamp(crop.top, 0, image.naturalHeight - 1)
    const cropBottom = clamp(crop.bottom, 0, image.naturalHeight - cropTop - 1)
    const sourceWidth = Math.max(1, image.naturalWidth - cropLeft - cropRight)
    const sourceHeight = Math.max(1, image.naturalHeight - cropTop - cropBottom)
    const quarterTurns = ((rotation % 360) + 360) % 360
    const swaps = quarterTurns === 90 || quarterTurns === 270
    canvas.width = swaps ? sourceHeight : sourceWidth
    canvas.height = swaps ? sourceWidth : sourceHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.save()
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((quarterTurns * Math.PI) / 180)
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
    ctx.filter = `brightness(${adjust.brightness}%) contrast(${adjust.contrast}%) saturate(${adjust.saturation}%)`
    ctx.drawImage(
      image,
      cropLeft,
      cropTop,
      sourceWidth,
      sourceHeight,
      -sourceWidth / 2,
      -sourceHeight / 2,
      sourceWidth,
      sourceHeight,
    )
    ctx.restore()
  }, [adjust.brightness, adjust.contrast, adjust.saturation, crop, flipX, flipY, rotation, sourceImage])

  useEffect(() => {
    renderCanvas()
  }, [renderCanvas])

  const reset = () => {
    setZoom(0.85)
    setRotation(0)
    setFlipX(false)
    setFlipY(false)
    setCrop({ top: 0, right: 0, bottom: 0, left: 0 })
    setAdjust({ brightness: 100, contrast: 100, saturation: 100 })
  }

  const exportPng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const link = document.createElement('a')
    const safeName = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'image'
    link.download = `${safeName}-edited.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }

  const dimensions = sourceImage ? `${sourceImage.naturalWidth}×${sourceImage.naturalHeight}` : ''
  const sizeLabel = size == null ? '' : size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`

  if (loading) {
    return <div className="image-editor-card"><div className="image-editor-empty">{text.loading}</div></div>
  }

  if (error || !sourceUrl || !sourceImage) {
    return <div className="image-editor-card"><div className="image-editor-error">{error ?? text.unsupported}</div></div>
  }

  return (
    <div className="image-editor-card">
      <div className="image-editor-toolbar">
        <div className="image-editor-filepath" title={filePath}>{filePath}</div>
        <div className="image-editor-meta">{[dimensions, sizeLabel].filter(Boolean).join(' · ')}</div>
        <div className="image-editor-actions">
          <button type="button" onClick={() => setZoom(0.85)}>{text.fit}</button>
          <button type="button" onClick={() => setZoom(1)}>{text.actual}</button>
          <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.2, 3))}>{text.zoomOut}</button>
          <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.2, 3))}>{text.zoomIn}</button>
          <button type="button" onClick={reset}>{text.reset}</button>
          <button type="button" className="is-primary" onClick={exportPng}>{text.export}</button>
        </div>
      </div>
      <div className="image-editor-body">
        <aside className="image-editor-panel">
          <div className="image-editor-panel-title">{text.adjust}</div>
          <label>{text.brightness}<input type="range" min="0" max="200" value={adjust.brightness} onChange={(event) => setAdjust((value) => ({ ...value, brightness: Number(event.target.value) }))} /></label>
          <label>{text.contrast}<input type="range" min="0" max="200" value={adjust.contrast} onChange={(event) => setAdjust((value) => ({ ...value, contrast: Number(event.target.value) }))} /></label>
          <label>{text.saturation}<input type="range" min="0" max="200" value={adjust.saturation} onChange={(event) => setAdjust((value) => ({ ...value, saturation: Number(event.target.value) }))} /></label>
          <div className="image-editor-panel-title">{text.crop}</div>
          {(['top', 'right', 'bottom', 'left'] as const).map((key) => (
            <label key={key}>{text[key]}<input type="number" min="0" max="9999" value={crop[key]} onChange={(event) => setCrop((value) => ({ ...value, [key]: Math.max(0, Number(event.target.value) || 0) }))} /></label>
          ))}
          <div className="image-editor-transform-grid">
            <button type="button" onClick={() => setRotation((value) => value - 90)}>{text.rotateLeft}</button>
            <button type="button" onClick={() => setRotation((value) => value + 90)}>{text.rotateRight}</button>
            <button type="button" onClick={() => setFlipX((value) => !value)}>{text.flipH}</button>
            <button type="button" onClick={() => setFlipY((value) => !value)}>{text.flipV}</button>
          </div>
        </aside>
        <div className="image-editor-stage">
          <canvas ref={canvasRef} style={{ width: `${zoom * 100}%`, maxWidth: zoom < 1 ? '100%' : 'none' }} />
        </div>
      </div>
    </div>
  )
}
