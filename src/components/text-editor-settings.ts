import type { EditorSettings } from '../../shared/schema'

// Lightweight distribution bridge for editor settings. The source of truth
// stays in appState.settings.editor — App publishes here so deeply nested
// editor cards can react without threading props through four layers.

const defaultSettings: EditorSettings = { fontSize: 13, wordWrap: false, minimap: false, tabSize: 2 }

let currentSettings: EditorSettings = defaultSettings
const listeners = new Set<() => void>()

const areEqual = (a: EditorSettings, b: EditorSettings) =>
  a.fontSize === b.fontSize &&
  a.wordWrap === b.wordWrap &&
  a.minimap === b.minimap &&
  a.tabSize === b.tabSize

export const getTextEditorSettings = (): EditorSettings => currentSettings

export const publishTextEditorSettings = (settings: EditorSettings) => {
  if (areEqual(currentSettings, settings)) {
    return
  }

  currentSettings = settings
  for (const listener of listeners) {
    listener()
  }
}

export const subscribeTextEditorSettings = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Reverse channel: editor cards live four layers below App and never see the
// reducer, but the statusbar word-wrap toggle must persist as the same global
// `settings.editor.wordWrap` that Settings → Editor edits. App registers one
// handler that dispatches `updateSettings`; with no host mounted (SSR tests)
// the request is a silent no-op rather than a local-only fork of the setting.
type TextEditorSettingsPatchHandler = (patch: Partial<EditorSettings>) => void

let patchHandler: TextEditorSettingsPatchHandler | null = null

export const registerTextEditorSettingsPatchHandler = (handler: TextEditorSettingsPatchHandler) => {
  patchHandler = handler
  return () => {
    if (patchHandler === handler) {
      patchHandler = null
    }
  }
}

export const requestTextEditorSettingsPatch = (patch: Partial<EditorSettings>) => {
  patchHandler?.(patch)
}
