export type AskUserDraft = {
  selected: string | null
  otherText: string
}

const draftCache = new Map<string, AskUserDraft>()

export function getAskUserDraft(itemId: string): AskUserDraft | null {
  return draftCache.get(itemId) ?? null
}

export function setAskUserDraft(itemId: string, draft: AskUserDraft): void {
  draftCache.set(itemId, { selected: draft.selected, otherText: draft.otherText })
}

export function clearAskUserDraft(itemId: string): void {
  draftCache.delete(itemId)
}

export function __resetAskUserDraftCacheForTests(): void {
  draftCache.clear()
}
