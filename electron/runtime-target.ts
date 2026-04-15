import path from 'node:path'

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
