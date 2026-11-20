import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAttachmentProtocolUrl } from '../shared/attachment-protocol.js'

export { attachmentProtocolScheme } from '../shared/attachment-protocol.js'

export type RendererLoadTarget =
  | { kind: 'url'; value: string }
  | { kind: 'file'; value: string }

export const getAttachmentUrl = (attachmentId: string) => getAttachmentProtocolUrl(attachmentId)

export const getRendererLoadTarget = ({
  isDev,
  clientDistDir,
  devServerUrl,
}: {
  isDev: boolean
  clientDistDir: string
  devServerUrl: string
}): RendererLoadTarget =>
  isDev
    ? {
        kind: 'url',
        value: devServerUrl,
      }
    : {
        kind: 'file',
        value: path.join(clientDistDir, 'index.html'),
      }

// 症状：链接/文件拖进窗口空白处或点到普通 <a href>，主框架被导航走，新页面继承 preload 的全部 electronAPI。
// 根因（2026-11-20 审查）：主窗口只有 setWindowOpenHandler，同窗口导航没有守卫。
// 打包版必须精确匹配 index.html 路径而不是放行整个 file: 协议——拖进来的本地 .html 也是 file://，放行即同样拿到 API。
export const isAppRendererUrl = (candidate: string, target: RendererLoadTarget): boolean => {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }

  if (target.kind === 'url') {
    let appOrigin: string
    try {
      appOrigin = new URL(target.value).origin
    } catch {
      return false
    }
    return appOrigin !== 'null' && url.origin === appOrigin
  }

  if (url.protocol !== 'file:') {
    return false
  }

  let candidatePath: string
  try {
    candidatePath = fileURLToPath(url)
  } catch {
    return false
  }

  const normalize = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(candidatePath) === normalize(target.value)
}
