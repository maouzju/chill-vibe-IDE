/**
 * Keep the live draft ref in lockstep with the local React state.
 *
 * The board composer is intentionally persisted on blur/unmount to avoid a
 * reducer dispatch for every keystroke. A tab switch can unmount the component
 * before React has flushed passive effects, so cleanup must read the value
 * written by the input event itself rather than the previous render.
 */
export const updateAutomationBoardDraft = (
  draftRef: { current: string },
  setDraft: (draft: string) => void,
  nextDraft: string,
) => {
  draftRef.current = nextDraft
  setDraft(nextDraft)
}
