// One-shot "scroll to this line when the editor mounts" intents, queued by the
// chat transcript when the user clicks `src/state.ts:120`.
//
// Deliberately a module-level registry rather than a card field: a line number is
// a single navigation intent, not state. Persisting it would make every restart
// re-jump old editor tabs, and it would drag a new field through shared/schema.ts
// + default-state.ts + normalizeAppSettings (pitfall #5/#6) for no lasting value.

import { getTextEditorModelCacheKey } from './text-editor-model-cache'

export const PENDING_EDITOR_REVEAL_LIMIT = 32
export const PENDING_EDITOR_REVEAL_TTL_MS = 60_000

type PendingReveal = {
  line: number
  queuedAt: number
}

const pendingReveals = new Map<string, PendingReveal>()

export const clearPendingEditorReveals = () => {
  pendingReveals.clear()
}

export const setPendingEditorReveal = (
  workspacePath: string,
  filePath: string,
  line: number | undefined,
  now: number = Date.now(),
) => {
  if (!Number.isFinite(line) || (line ?? 0) < 1) {
    return
  }

  const key = getTextEditorModelCacheKey(workspacePath, filePath)
  pendingReveals.delete(key)
  pendingReveals.set(key, { line: Math.floor(line as number), queuedAt: now })

  // A queued reveal whose card never mounts (tab closed mid-open, pane removed)
  // would otherwise sit here forever; evict oldest-first.
  while (pendingReveals.size > PENDING_EDITOR_REVEAL_LIMIT) {
    const oldestKey = pendingReveals.keys().next().value

    if (oldestKey === undefined) {
      break
    }

    pendingReveals.delete(oldestKey)
  }
}

export const consumePendingEditorReveal = (
  workspacePath: string,
  filePath: string,
  now: number = Date.now(),
): number | null => {
  const key = getTextEditorModelCacheKey(workspacePath, filePath)
  const entry = pendingReveals.get(key)

  if (!entry) {
    return null
  }

  pendingReveals.delete(key)

  return now - entry.queuedAt > PENDING_EDITOR_REVEAL_TTL_MS ? null : entry.line
}
