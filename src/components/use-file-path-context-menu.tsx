import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'

import type { AppLanguage } from '../../shared/schema'
import { openMessageLocalLink } from '../api'
import { FilePathContextMenu } from './FilePathContextMenu'
import {
  buildFilePathContextMenuActions,
  clampFilePathContextMenuPosition,
  resolveFilePathContextMenuCopyValue,
  resolveFilePathContextMenuTarget,
  type FilePathContextMenuActionKey,
  type FilePathContextMenuTarget,
} from './file-path-context-menu'

export const useFilePathContextMenu = ({
  language,
  workspacePath,
  onOpenFile,
}: {
  language: AppLanguage
  workspacePath: string
  onOpenFile?: (relativePath: string, options?: { line?: number }) => void
}) => {
  const [menuState, setMenuState] = useState<{
    target: FilePathContextMenuTarget
    x: number
    y: number
  } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const closeMenu = useCallback(() => {
    setMenuState(null)
    setPosition(null)
  }, [])

  useEffect(() => {
    if (!menuState) {
      return
    }

    const handlePointerDown = (event: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu()
      }
    }
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    window.addEventListener('blur', closeMenu)

    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menuState, closeMenu])

  useLayoutEffect(() => {
    if (!menuState) {
      return
    }

    const node = menuRef.current

    if (!node) {
      return
    }

    const rect = node.getBoundingClientRect()
    const next = clampFilePathContextMenuPosition({
      x: menuState.x,
      y: menuState.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    })

    setPosition((current) =>
      current && current.left === next.left && current.top === next.top ? current : next,
    )
  }, [menuState])

  const handleContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = resolveFilePathContextMenuTarget(event.target)

    if (!target) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    setMenuState({ target, x: event.clientX, y: event.clientY })
    setPosition({ left: event.clientX, top: event.clientY })
  }, [])

  const actions = useMemo(
    () =>
      buildFilePathContextMenuActions({
        language,
        canOpenInEditor: Boolean(onOpenFile),
        revealOnly: menuState?.target.revealOnly === true,
      }),
    [language, onOpenFile, menuState],
  )

  const runAction = useCallback(
    (key: FilePathContextMenuActionKey) => {
      const target = menuState?.target
      closeMenu()

      if (!target) {
        return
      }

      if (key === 'open') {
        onOpenFile?.(target.openPath, target.line ? { line: target.line } : undefined)
        return
      }

      if (key === 'reveal') {
        void openMessageLocalLink(target.openPath, workspacePath).catch(() => undefined)
        return
      }

      const copyValue = resolveFilePathContextMenuCopyValue(workspacePath, target.openPath)
      void navigator.clipboard?.writeText(copyValue).catch(() => undefined)
    },
    [menuState, closeMenu, onOpenFile, workspacePath],
  )

  const menu =
    menuState && position && typeof document !== 'undefined'
      ? createPortal(
          <FilePathContextMenu
            ref={menuRef}
            position={position}
            actions={actions}
            onSelect={runAction}
          />,
          document.body,
        )
      : null

  return { handleContextMenu, menu }
}
