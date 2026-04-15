import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { randomUUID } from 'node:crypto'

import type {
  AttachmentUploadRequest,
  ImageAttachment,
  ImageAttachmentMimeType,
} from '../shared/schema.js'
import { getAttachmentsDir } from './app-paths.js'

const maxImageAttachmentBytes = 10 * 1024 * 1024

const imageExtensionByMimeType: Record<ImageAttachmentMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const resolveAttachmentPath = (attachmentId: string) => {
  const attachmentsDir = getAttachmentsDir()
  const safeId = path.basename(attachmentId)
  const filePath = path.join(attachmentsDir, safeId)
  const resolvedPath = path.resolve(filePath)
  const resolvedRoot = path.resolve(attachmentsDir)

  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Invalid attachment path.')
  }

  return resolvedPath
}

export const storeImageAttachment = async (
  request: AttachmentUploadRequest,
): Promise<ImageAttachment> => {
  const buffer = Buffer.from(request.dataBase64, 'base64')

  if (buffer.byteLength === 0) {
    throw new Error('The pasted image was empty.')
  }

  if (buffer.byteLength > maxImageAttachmentBytes) {
    throw new Error('Pasted images must be 10 MB or smaller.')
  }

  const extension = imageExtensionByMimeType[request.mimeType]
  const id = `${randomUUID()}.${extension}`
  const filePath = resolveAttachmentPath(id)
  const attachmentsDir = getAttachmentsDir()

  await mkdir(attachmentsDir, { recursive: true })
  await writeFile(filePath, buffer)

  return {
    id,
    fileName: request.fileName?.trim() || `pasted-image.${extension}`,
    mimeType: request.mimeType,
    sizeBytes: buffer.byteLength,
  }
}

export const resolveImageAttachmentPath = async (attachmentId: string) => {
  const filePath = resolveAttachmentPath(attachmentId)
  const info = await stat(filePath)

  if (!info.isFile()) {
    throw new Error('Attachment not found.')
  }

  return filePath
}
