import type { AppLanguage } from '../../shared/schema'

// Every openable file surface in a chat transcript already tags itself with this
// attribute so the click handler can find its target: changes-summary rows,
// structured-edits rows, tool detail rows, inline markdown file references.
// The right-click menu reuses the same tag instead of re-plumbing a callback
// through each of those components.
export const FILE_PATH_CONTEXT_MENU_SELECTOR = '[data-open-file-path]'

export type FilePathContextMenuTarget = {
  openPath: string
  line?: number
  // A local markdown link can point at a directory, an extension-less file, or a
  // path this card has no editor for. Those still deserve "show file location",
  // so they get tagged instead of silently dropping out of the menu entirely.
  revealOnly?: true
}

export type FilePathContextMenuActionKey = 'open' | 'reveal' | 'copy-path'

export type FilePathContextMenuAction = {
  key: FilePathContextMenuActionKey
  label: string
}

type ClosestCapableNode = {
  closest?: (selector: string) => { getAttribute?: (name: string) => string | null } | null
}

const absolutePathPattern = /^(?:[a-z]:[\\/]|\\\\|\/|file:\/\/)/i

export const resolveFilePathContextMenuTarget = (node: unknown): FilePathContextMenuTarget | null => {
  const host = (node as ClosestCapableNode | null)?.closest?.(FILE_PATH_CONTEXT_MENU_SELECTOR) ?? null

  if (!host) {
    return null
  }

  const openPath = host.getAttribute?.('data-open-file-path')?.trim()

  if (!openPath) {
    return null
  }

  if (host.getAttribute?.('data-open-file-reveal-only') === 'true') {
    return { openPath, revealOnly: true }
  }

  const rawLine = host.getAttribute?.('data-open-file-line')?.trim()
  const line = rawLine ? Number.parseInt(rawLine, 10) : Number.NaN

  return Number.isFinite(line) && line > 0 ? { openPath, line } : { openPath }
}

export const getFilePathContextMenuLabels = (language: AppLanguage) =>
  language === 'en'
    ? {
        open: 'Open File',
        reveal: 'Show File Location',
        copyPath: 'Copy Path',
      }
    : {
        open: '打开文件',
        reveal: '打开文件位置',
        copyPath: '复制路径',
      }

export const buildFilePathContextMenuActions = ({
  language,
  canOpenInEditor,
  revealOnly = false,
}: {
  language: AppLanguage
  canOpenInEditor: boolean
  revealOnly?: boolean
}): FilePathContextMenuAction[] => {
  const labels = getFilePathContextMenuLabels(language)
  const actions: FilePathContextMenuAction[] = []

  if (canOpenInEditor && !revealOnly) {
    actions.push({ key: 'open', label: labels.open })
  }

  actions.push({ key: 'reveal', label: labels.reveal })
  actions.push({ key: 'copy-path', label: labels.copyPath })

  return actions
}

const CONTEXT_MENU_VIEWPORT_MARGIN = 8

export const clampFilePathContextMenuPosition = ({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
}: {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}) => ({
  left: Math.min(
    Math.max(x, CONTEXT_MENU_VIEWPORT_MARGIN),
    Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, viewportWidth - width - CONTEXT_MENU_VIEWPORT_MARGIN),
  ),
  top: Math.min(
    Math.max(y, CONTEXT_MENU_VIEWPORT_MARGIN),
    Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, viewportHeight - height - CONTEXT_MENU_VIEWPORT_MARGIN),
  ),
})

// "Copy path" is only useful if the copied text can be pasted somewhere else, so
// workspace-relative rows get expanded back into an absolute path.
export const resolveFilePathContextMenuCopyValue = (workspacePath: string, openPath: string) => {
  if (absolutePathPattern.test(openPath)) {
    return openPath
  }

  const workspaceRoot = workspacePath.trim().replace(/[\\/]+$/, '')

  if (!workspaceRoot) {
    return openPath
  }

  const separator = workspaceRoot.includes('\\') ? '\\' : '/'

  return `${workspaceRoot}${separator}${openPath.split('/').join(separator)}`
}
