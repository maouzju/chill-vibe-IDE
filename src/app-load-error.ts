import type { AppLanguage } from '../shared/schema.ts'
import { normalizeLanguage } from '../shared/i18n.ts'

export type AppLoadErrorCopy = {
  title: string
  description: string
}

const desktopBridgeUnavailablePattern = /electron desktop bridge is unavailable/i

const genericErrorCopyByLanguage: Record<AppLanguage, AppLoadErrorCopy> = {
  'zh-CN': {
    title: '无法连接本地工作区服务',
    description: '请重启桌面客户端，然后再试一次。',
  },
  en: {
    title: 'Unable to reach the local workspace service',
    description: 'Restart the desktop app, then try again.',
  },
}

const desktopBridgeErrorCopyByLanguage: Record<AppLanguage, AppLoadErrorCopy> = {
  'zh-CN': {
    title: '当前窗口未连接到桌面客户端',
    description:
      '请使用 Electron 桌面客户端打开 Chill Vibe 后再试一次；如果你已经在桌面客户端中，请重启应用。',
  },
  en: {
    title: 'This window is not connected to the desktop client',
    description:
      'Open Chill Vibe in the Electron desktop app, then try again. If you are already in the desktop app, restart it.',
  },
}

export const resolveAppLoadError = (
  language: AppLanguage,
  error: unknown,
): AppLoadErrorCopy => {
  const normalizedLanguage = normalizeLanguage(language)
  const message = error instanceof Error ? error.message : String(error ?? '')

  if (desktopBridgeUnavailablePattern.test(message)) {
    return desktopBridgeErrorCopyByLanguage[normalizedLanguage]
  }

  return genericErrorCopyByLanguage[normalizedLanguage]
}
