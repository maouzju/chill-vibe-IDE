import { useEffect, useRef } from 'react'

const focusableDialogSelector = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ')

const findFirstFocusable = (root: HTMLElement) =>
  root.querySelector<HTMLElement>(focusableDialogSelector)

export const useDialogFocus = <T extends HTMLElement = HTMLElement>({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) => {
  const dialogRef = useRef<T | null>(null)
  const lastFocusedElementRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') {
      return
    }

    lastFocusedElementRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const dialog = dialogRef.current
    const focusTarget = dialog ? findFirstFocusable(dialog) ?? dialog : null
    focusTarget?.focus({ preventScroll: true })

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key !== 'Tab' || !dialogRef.current) {
        return
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableDialogSelector),
      ).filter((element) => element.offsetParent !== null || element === document.activeElement)

      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current.focus({ preventScroll: true })
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      if (lastFocusedElementRef.current?.isConnected) {
        lastFocusedElementRef.current.focus({ preventScroll: true })
      }
      lastFocusedElementRef.current = null
    }
  }, [isOpen])

  return dialogRef
}
