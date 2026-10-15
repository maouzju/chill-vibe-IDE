import type { AppLanguage } from '../../shared/schema'

// 症状 (2026-10-14): 桌面版文件树改名/移动/删除失败时，对话框里是
//   "Error invoking remote method 'desktop:rename-entry': Error: EPERM: operation not permitted, rename 'D:\…'"
//   这种英文 IPC 包装 + errno + 本机绝对路径，中文界面用户看不懂发生了什么。
// 根因: 2026-10-14 读码确认 FileTreeCard 直接展示 reason.message；Electron 的 ipcRenderer.invoke
//   会给主进程抛出的错误套上 "Error invoking remote method '<channel>': Error: " 前缀，HTTP 路径则没有。
// 为什么不在主进程改错误: 包装是 Electron 在渲染进程侧加的，主进程控制不了；按稳定的服务端文案
//   和 errno 代码映射，未识别的消息仍原样（去包装后）展示，不吞信息。

export const unwrapIpcErrorMessage = (raw: string) => {
  const unwrapped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '')
  return unwrapped.replace(/^(?:Error|Uncaught \w*Error):\s*/, '').trim() || raw
}

type LocalizedText = { zh: string; en: string | null }

const ALREADY_EXISTS: LocalizedText = {
  zh: '已存在同名文件或文件夹。',
  en: 'A file or folder with that name already exists.',
}

const SOURCE_MISSING: LocalizedText = {
  zh: '原文件或文件夹已不存在（可能已被移动或删除），请刷新文件树后重试。',
  en: 'The file or folder no longer exists (it may have been moved or deleted). Refresh the tree and try again.',
}

const ENTRY_BUSY: LocalizedText = {
  zh: '文件或文件夹正被占用或没有权限（例如其中的文件正被编辑器、终端或其他程序打开），请关闭后重试。',
  en: 'The file or folder is in use or access is denied (for example a file inside it is open in an editor, terminal or another program). Close it and try again.',
}

// Server-side validation messages are already readable English, so `en: null`
// keeps them verbatim; only the Chinese UI needs a translation.
const exactMessages = new Map<string, LocalizedText>([
  ['Target already exists.', ALREADY_EXISTS],
  ['Path not found.', SOURCE_MISSING],
  ['Entry name is required.', { zh: '名称不能为空。', en: null }],
  ['Entry names must not contain path separators.', { zh: '名称不能是 . 或 ..，也不能包含 / 或 \\。', en: null }],
  ['Entry names must not contain control characters.', { zh: '名称不能包含控制字符。', en: null }],
  [
    'Entry names must not contain any of these characters on Windows: < > : " | ? *',
    { zh: '名称不能包含以下字符：< > : " | ? *', en: null },
  ],
  ['Entry names must not end with a dot or a space on Windows.', { zh: '名称不能以点或空格结尾。', en: null }],
  ['Cannot move a directory into its own descendant.', { zh: '不能把文件夹移动到它自己的子文件夹里。', en: null }],
  ['Destination parent path must be a directory.', { zh: '目标位置不是文件夹。', en: null }],
  ['Parent path must be a directory.', { zh: '目标位置不是文件夹。', en: null }],
  ['Path traversal is not allowed.', { zh: '不能操作工作区以外的路径。', en: null }],
])

const RESERVED_DEVICE_NAME_PATTERN = /^"(.+)" is a reserved device name on Windows\.$/
const ALREADY_EXISTS_PATTERN = /\bEEXIST\b/
const MISSING_PATTERN = /\bENOENT\b|no such file or directory/i
const BUSY_PATTERN = /\b(?:EPERM|EBUSY|EACCES)\b|operation not permitted|resource busy or locked/i

const pick = (text: LocalizedText, language: AppLanguage, fallback: string) =>
  language === 'en' ? (text.en ?? fallback) : text.zh

export const describeFileActionError = (reason: unknown, language: AppLanguage) => {
  const genericError = language === 'en' ? 'The file action failed.' : '文件操作失败。'

  if (!(reason instanceof Error) || !reason.message.trim()) {
    return genericError
  }

  const message = unwrapIpcErrorMessage(reason.message)
  const exact = exactMessages.get(message)
  if (exact) {
    return pick(exact, language, message)
  }

  const reservedName = RESERVED_DEVICE_NAME_PATTERN.exec(message)?.[1]
  if (reservedName) {
    return language === 'en' ? message : `“${reservedName}”是 Windows 保留的设备名，不能用作名称。`
  }

  if (ALREADY_EXISTS_PATTERN.test(message)) {
    return pick(ALREADY_EXISTS, language, message)
  }

  if (MISSING_PATTERN.test(message)) {
    return pick(SOURCE_MISSING, language, message)
  }

  if (BUSY_PATTERN.test(message)) {
    return pick(ENTRY_BUSY, language, message)
  }

  return message
}
