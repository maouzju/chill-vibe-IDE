// 粘贴图片这件事原本只长在聊天 composer 上。自动化看板的「加入待命」也要能
// 粘图（需求经常就是一张截图），所以把"从剪贴板挑出图片 / 把本地 File 传成
// ImageAttachment"这两步抽出来共用 —— 手抄一份意味着受支持的图片类型、
// 上传失败的错误文案、data-url 切分这三处以后要各改两遍。

import { uploadImageAttachment } from '../api'
import type { ImageAttachment } from '../../shared/schema'
import type { PendingComposerAttachment } from './composer-draft-attachments'

export const supportedImageMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/**
 * 从剪贴板条目里挑出可用的图片文件。
 *
 * 只认 `kind === 'file'`：文本形态的图片（例如 HTML 里的 <img src>）在调用方
 * 有更好的处理路径（内部便签图片直接复用原附件 id，不重新上传）。
 */
export const collectPastedImageFiles = (items: DataTransferItemList | null): File[] => {
  if (!items) {
    return []
  }

  return Array.from(items).flatMap((item) => {
    if (item.kind !== 'file' || !supportedImageMimeTypes.has(item.type)) {
      return []
    }

    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new Error('Unable to read the pasted image.'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the pasted image.'))
    reader.readAsDataURL(file)
  })

export const uploadPendingImage = async (
  attachment: PendingComposerAttachment,
): Promise<ImageAttachment> => {
  if (attachment.kind === 'uploaded') {
    return attachment.attachment
  }

  const dataUrl = await readFileAsDataUrl(attachment.file)
  const base64Index = dataUrl.indexOf(',')

  if (base64Index < 0) {
    throw new Error('Unable to read the pasted image.')
  }

  return uploadImageAttachment({
    fileName: attachment.file.name,
    mimeType: attachment.file.type as ImageAttachment['mimeType'],
    dataBase64: dataUrl.slice(base64Index + 1),
  })
}
