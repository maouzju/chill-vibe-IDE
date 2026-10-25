// 症状：会话里 AI 回复带的图（本地路径走 chill-vibe-local-image://）右键没法复制。
// 根因：自定义协议对渲染进程 fetch/canvas 不可读（跨源且无 CORS 头 → 画布被污染），
// 所以字节由主进程抓，渲染进程只负责转成 PNG 写剪贴板。
// 为什么不在主进程直接 clipboard.writeImage：nativeImage 不认 webp/svg，转码在渲染进程才通吃。
import { isCopyableImageSrc } from '../../shared/local-image-protocol'

type ImageBytesBridge = (request: { src: string }) => Promise<{ mimeType: string; data: Uint8Array }>

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Image could not be decoded.'))
    image.src = url
  })

const toPngBlob = async (blob: Blob): Promise<Blob> => {
  if (blob.type === 'image/png') {
    return blob
  }

  const objectUrl = URL.createObjectURL(blob)

  try {
    const image = await loadImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || 1024
    canvas.height = image.naturalHeight || 1024
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('PNG encoding failed.'))),
        'image/png',
      ),
    )
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export const copyImageToClipboard = async (src: string): Promise<void> => {
  if (!isCopyableImageSrc(src)) {
    throw new Error('This image source cannot be copied.')
  }

  const fetchBytes = (window.electronAPI as { fetchImageBytes?: ImageBytesBridge } | undefined)
    ?.fetchImageBytes
  let blob: Blob

  if (fetchBytes) {
    const { mimeType, data } = await fetchBytes({ src })
    blob = new Blob([data as BlobPart], { type: mimeType.split(';')[0].trim().toLowerCase() })
  } else {
    const response = await fetch(src)

    if (!response.ok) {
      throw new Error('Image request failed.')
    }

    blob = await response.blob()
  }

  const png = await toPngBlob(blob)
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}
