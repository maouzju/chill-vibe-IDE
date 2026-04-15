export const attachmentProtocolScheme = 'chill-vibe-attachment'

export const getAttachmentProtocolUrl = (attachmentId: string) =>
  `${attachmentProtocolScheme}://local/${encodeURIComponent(attachmentId)}`
