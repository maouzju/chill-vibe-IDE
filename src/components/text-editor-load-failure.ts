import type { AppLanguage } from '../../shared/schema'

import { getTextEditorCardText } from './tool-card-text'

// Chat file references are heuristic: a model can name a path that does not exist
// (typo, a file from another repo, a file it planned but never wrote). Raising a
// raw `ENOENT: no such file or directory, open 'D:\...'` at the user makes that
// look like an app failure instead of "that file isn't there".
const MISSING_FILE_PATTERN = /\bENOENT\b|no such file or directory|path not found/i

// The desktop IPC channel can open files outside the workspace (electron/backend.ts
// DESKTOP_FILE_ACCESS), but the HTTP path deliberately cannot. Without this branch the
// server's raw English "Path traversal is not allowed." reaches the user as if the app
// had broken — which is exactly how the 2026-08-14 report described it.
const RESTRICTED_PATH_PATTERN = /path traversal is not allowed/i

export const describeTextEditorLoadFailure = (reason: unknown, language: AppLanguage): string => {
  if (!(reason instanceof Error)) {
    return 'Failed to load file'
  }

  if (RESTRICTED_PATH_PATTERN.test(reason.message)) {
    return getTextEditorCardText(language).restrictedFile
  }

  return MISSING_FILE_PATTERN.test(reason.message)
    ? getTextEditorCardText(language).missingFile
    : reason.message
}
