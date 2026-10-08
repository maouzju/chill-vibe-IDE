import { uploadImageAttachment } from '../api'
import type { ImageAttachment } from '../../shared/schema'
import type { PendingComposerAttachment } from './composer-draft-attachments'

export const supportedImageMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** 从原生剪贴板条目里挑出可用的图片文件。 */
export const collectPastedImageFiles = (items: DataTransferItemList | null): File[] => {
  if (!items) return []

  return Array.from(items).flatMap((item) => {
    if (item.kind !== 'file' || !supportedImageMimeTypes.has(item.type)) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

const MAX_PASTED_HTML_LENGTH = 2_000_000
const MAX_HTML_IMAGE_SOURCES = 8

const decodeHtmlAttribute = (value: string) => value
  .replaceAll('&quot;', '"')
  .replaceAll('&#34;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&')

const safeImageSourcePattern = /^(?:data:image\/(?:png|jpeg|webp|gif);base64,|https?:\/\/)/iu

/**
 * 提取富文本剪贴板中的图片地址。飞书有时把真实图片放在 data-src、
 * data-original 或 data-image-src，而不是直接放在 src 里；每个 img 只取
 * 第一个安全地址，不解析或执行其他 HTML。
 */
export const collectPastedImageSources = (html: string): string[] => {
  if (!html || html.length > MAX_PASTED_HTML_LENGTH) return []

  const sources: string[] = []
  const seen = new Set<string>()
  const imagePattern = /<img\b[^>]*>/giu
  const sourcePattern = /(?:^|\s)(?:src|data-src|data-original|data-image-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu

  for (const imageMatch of html.matchAll(imagePattern)) {
    const tag = imageMatch[0]
    for (const sourceMatch of tag.matchAll(sourcePattern)) {
      const source = decodeHtmlAttribute(sourceMatch[1] ?? sourceMatch[2] ?? sourceMatch[3] ?? '').trim()
      if (!safeImageSourcePattern.test(source) || seen.has(source)) continue
      seen.add(source)
      sources.push(source)
      break
    }
    if (sources.length >= MAX_HTML_IMAGE_SOURCES) break
  }
  return sources
}
const extensionForMimeType = (mimeType: string) =>
  mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1] || 'png'

const dataUrlToFile = (dataUrl: string, index: number): File | null => {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]*)$/iu)
  if (!match) return null
  try {
    const bytes = Uint8Array.from(atob(match[2]), (character) => character.charCodeAt(0))
    return new File([bytes], `pasted-image-${index + 1}.${extensionForMimeType(match[1])}`, {
      type: match[1].toLowerCase(),
    })
  } catch {
    return null
  }
}

/** 将 HTML 图片源尽力转换成可复用的 File；单张图片失败不会影响其他图片。 */
export const fetchPastedImageFiles = async (sources: readonly string[]): Promise<File[]> => {
  const files: File[] = []
  for (const [index, source] of sources.entries()) {
    const dataFile = source.startsWith('data:') ? dataUrlToFile(source, index) : null
    if (dataFile) {
      files.push(dataFile)
      continue
    }
    if (!/^https?:\/\//iu.test(source)) continue
    try {
      const response = await fetch(source)
      if (!response.ok) continue
      const blob = await response.blob()
      const mimeType = blob.type.toLowerCase()
      if (!supportedImageMimeTypes.has(mimeType) || blob.size === 0) continue
      const url = new URL(source)
      const name = url.pathname.split('/').filter(Boolean).pop() || `pasted-image-${index + 1}`
      files.push(new File([blob], name.includes('.') ? name : `${name}.${extensionForMimeType(mimeType)}`, {
        type: mimeType,
      }))
    } catch {
      // 外部图片可能需要登录或被 CORS 拒绝；文字仍应正常粘贴。
    }
  }
  return files
}

export const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') return resolve(reader.result)
      reject(new Error('Unable to read the pasted image.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the pasted image.'))
    reader.readAsDataURL(file)
  })

export const uploadPendingImage = async (
  attachment: PendingComposerAttachment,
): Promise<ImageAttachment> => {
  if (attachment.kind === 'uploaded') return attachment.attachment

  const dataUrl = await readFileAsDataUrl(attachment.file)
  const base64Index = dataUrl.indexOf(',')
  if (base64Index < 0) throw new Error('Unable to read the pasted image.')

  return uploadImageAttachment({
    fileName: attachment.file.name,
    mimeType: attachment.file.type as ImageAttachment['mimeType'],
    dataBase64: dataUrl.slice(base64Index + 1),
  })
}
