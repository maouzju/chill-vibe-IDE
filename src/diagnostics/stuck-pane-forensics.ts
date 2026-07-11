// Stuck-pane forensics: when the composer/tab UI stops responding we have so
// far only been able to reason about the failure from symptoms — this module
// captures the actual crime scene. It keeps a rolling ledger of "where the
// event system says a pointerdown landed vs. where main-thread layout says it
// landed" (disagreement is the stale hit-test smoking gun), and on demand
// (Ctrl+Shift+F9) or automatically (repeated rescue firings) assembles a
// snapshot of focus, pane/tab geometry, an elementFromPoint grid, and rAF
// heartbeats, then persists it via the desktop bridge to logs/.
//
// The decision core is pure and dependency-injected so it stays node:test-able.

export type ForensicsElementLike = {
  tagName: string
  className: string
  id: string
  parentElement: ForensicsElementLike | null
  getAttribute: (name: string) => string | null
  contains: (other: ForensicsElementLike | null) => boolean
}

export type PointerLedgerEntry = {
  atMs: number
  x: number
  y: number
  button: number
  targetPath: string
  hitPath: string
  agree: boolean
}

export const pointerLedgerCapacity = 20

export const pushPointerLedgerEntry = (
  ledger: PointerLedgerEntry[],
  entry: PointerLedgerEntry,
  capacity = pointerLedgerCapacity,
): PointerLedgerEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

// Focus transitions ledger (dump 07-08T04-05: presses land on the textarea,
// focus settles, yet ends on <body> with all rescue counters 0). Some removal
// paths are silent; React's commit deletion path can instead fire focusout
// while the target is still connected, then detach it before the microtask
// checkpoint (dump 07-10T04-23). Record both sides of that boundary.
export type FocusLedgerEntry = {
  atMs: number
  kind: 'focusin' | 'focusout'
  path: string
  // focusout only: where focus went (relatedTarget). '(null)' means focus fell
  // to nowhere — the fingerprint of a programmatic blur()/attribute flip, since
  // a user press always names the element it moved to.
  relatedPath?: string
  // focusout-to-nowhere only. false = the OS window itself lost focus (IME
  // candidate window, system popup) — a DOM-level fixup keeps the document
  // focused while kicking the element.
  docHasFocus?: boolean
  // focusout-to-nowhere only: what made the element unfocusable, interrogated
  // synchronously while the flip is still in effect. null = the chain looks
  // focusable from here, so the steal was window-level or a plain focus move.
  unfocusableCause?: UnfocusableCause | null
  // focusout-to-nowhere only: a fixup dispatched synchronously from an
  // attribute flip carries the flipping commit in these frames.
  stackTop?: string
  // focusout-to-nowhere only: connectivity during dispatch and immediately
  // after the current commit. true -> false is a React/DOM removal signature.
  connectedAtDispatch?: boolean
  connectedAfterMicrotask?: boolean
  // When the target was detached, name both the detached subtree root and the
  // old target-to-root chain so the next dump identifies what React removed.
  detachedRootPath?: string
  detachedTargetPath?: string
}

export const focusLedgerCapacity = 30

export const pushFocusLedgerEntry = (
  ledger: FocusLedgerEntry[],
  entry: FocusLedgerEntry,
  capacity = focusLedgerCapacity,
): FocusLedgerEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

// Reactive focus kick (dump 07-08T06-22): focusin lands on an element and a
// focusout to NOWHERE follows within milliseconds — something reacts to the
// focus itself and kicks it out. A focusout that hands focus to a real element
// is a deliberate move; one that takes hundreds of ms is user pacing. Only the
// fast focusin→focusout-to-nowhere pair on the same element is the kick.
export const reactiveFocusKickWindowMs = 50

// The browser drops the focus-visible class the instant focus leaves, so the
// focusin path reads `textarea.….focus-visible > …` while the paired focusout
// reads `textarea.… > …` (dump 07-09T09-16 missed every kick this way). Strip
// it before comparing so class churn can't hide a same-element pair.
const normalizeFocusPath = (path: string): string =>
  path.replace(/\.focus-visible(?=[\s.[]|$)/g, '')

export const countReactiveFocusKicks = (
  ledger: FocusLedgerEntry[],
  kickWindowMs = reactiveFocusKickWindowMs,
): number => {
  let kicks = 0
  for (let index = 1; index < ledger.length; index += 1) {
    const previous = ledger[index - 1]!
    const current = ledger[index]!
    if (
      previous.kind === 'focusin' &&
      current.kind === 'focusout' &&
      normalizeFocusPath(current.path) === normalizeFocusPath(previous.path) &&
      current.relatedPath === '(null)' &&
      current.atMs - previous.atMs <= kickWindowMs
    ) {
      kicks += 1
    }
  }
  return kicks
}

// Programmatic focus/blur call ledger. A reactive kick is necessarily
// programmatic — only blur()/focus() calls or attribute flips move focus with
// no gesture — so recording every caller with a stack top names the culprit
// directly. `landed` on focus() calls also proves whether the self-heal
// ladders' reclaim attempts actually took (a false here with the textarea as
// the target is the "unfocusable composer" smoking gun).
export type FocusMethodCallEntry = {
  atMs: number
  kind: 'focus' | 'blur'
  path: string
  landed?: boolean
  stackTop: string
}

export const focusMethodCallCapacity = 30

export const pushFocusMethodCallEntry = (
  ledger: FocusMethodCallEntry[],
  entry: FocusMethodCallEntry,
  capacity = focusMethodCallCapacity,
): FocusMethodCallEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

export const summarizeCallStack = (stack: string | undefined, maxFrames: number): string => {
  if (!stack) {
    return ''
  }
  return stack.split('\n').slice(0, maxFrames).join('\n')
}

// Composer attribute mutation ledger — the OTHER way to kick focus without a
// gesture: flipping disabled/hidden/inert (or a display-changing style) on the
// focused element's chain runs the browser's focus fixup. Noise rules:
// focus-visible class churn tracks every focus transition and says nothing;
// style writes are the textarea height sync unless they touch
// display/visibility.
export type ComposerAttributeMutationEntry = {
  atMs: number
  attr: string
  value: string | null
  path: string
}

export const composerAttributeMutationCapacity = 40

export const pushComposerAttributeMutationEntry = (
  ledger: ComposerAttributeMutationEntry[],
  entry: ComposerAttributeMutationEntry,
  capacity = composerAttributeMutationCapacity,
): ComposerAttributeMutationEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

// The fixed layout layers on the composer textarea's ancestor chain — the
// exact walk the browser's focus fixup takes. Dump 07-09T09-16 blind spot:
// only TEXTAREA/.composer/pane-tab-panel were admitted, so card-footer,
// card-shell and the pane/split layers could flip display-affecting
// attributes without a trace. Message content layers stay out on purpose:
// their streaming churn would flush the bounded ledger.
export const composerChainLayerClasses = [
  'card-shell',
  'card-footer',
  'composer',
  'composer-input-row',
  'pane-tab-panel',
  'pane-content',
  'pane-view',
  'pane-tab-strip',
  'pane-tab-bar',
  'split-child',
  'split-container',
]

const stripFocusVisible = (classValue: string | null): string =>
  (classValue ?? '')
    .split(/\s+/)
    .filter((token) => token && token !== 'focus-visible')
    .sort()
    .join(' ')

const touchesDisplayOrVisibility = (styleValue: string | null): boolean =>
  /display|visibility/i.test(styleValue ?? '')

export const shouldRecordComposerAttributeMutation = (input: {
  attributeName: string
  oldValue: string | null
  newValue: string | null
}): boolean => {
  if (input.attributeName === 'class') {
    return stripFocusVisible(input.oldValue) !== stripFocusVisible(input.newValue)
  }
  if (input.attributeName === 'style') {
    return touchesDisplayOrVisibility(input.oldValue) || touchesDisplayOrVisibility(input.newValue)
  }
  return true
}

// ── panel unmount probe ──────────────────────────────────────────────────────
// Dump 2026-07-11T07-19: React commitDeletion removed the focused
// `pane-tab-panel.is-active` itself (focusout stack = react-dom removeChild,
// connectedAfterMicrotask=false, detachedRootPath=the panel div), then the
// same tabId remounted — 8 delete/rebuild oscillations in ~3s. The reducer has
// no tab-removal path in a streaming window, so the next dump must answer ONE
// question at the unmount instant: does the DATA layer (appStateRef truth)
// still contain the tab the render just dropped? Divergence = a committed
// render used a state missing the tab (React lane/rebase class); agreement =
// a real action removed it, and the applied-actions ledger names it.

export type PanelUnmountEntry = {
  atMs: number
  tabId: string
  paneId: string
  activeAtUnmount: boolean
  // null = no truth getter registered (probe fired before App wiring).
  dataLayerHasTab: boolean | null
  dataLayerHasCard: boolean | null
}

export const panelUnmountCapacity = 20

export const pushPanelUnmountEntry = (
  ledger: PanelUnmountEntry[],
  entry: PanelUnmountEntry,
  capacity = panelUnmountCapacity,
): PanelUnmountEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

// Minimal structural view of AppState so the walk stays node:test-able and
// this module does not depend on the full schema types.
type ForensicsLayoutNodeLike =
  | { type: 'pane'; tabs: string[] }
  | { type: 'split'; children: ForensicsLayoutNodeLike[] }

export type ForensicsAppStateLike = {
  columns: Array<{
    cards: Record<string, unknown>
    layout?: ForensicsLayoutNodeLike | null
  }>
}

const layoutContainsTab = (node: ForensicsLayoutNodeLike | null | undefined, tabId: string): boolean => {
  if (!node) {
    return false
  }
  if (node.type === 'pane') {
    return node.tabs.includes(tabId)
  }
  return node.children.some((child) => layoutContainsTab(child, tabId))
}

export const locateTabInAppState = (
  state: ForensicsAppStateLike,
  tabId: string,
): { tabInLayout: boolean; cardPresent: boolean } => ({
  tabInLayout: state.columns.some((column) => layoutContainsTab(column.layout, tabId)),
  cardPresent: state.columns.some((column) => tabId in column.cards),
})

// Applied-action ledger: every reducer batch, so a real tab-removing action
// (or a suspicious absence of any action around an unmount) is visible in the
// same dump timeline.
export type AppliedActionsEntry = {
  atMs: number
  types: string[]
}

export const appliedActionsCapacity = 40

export const pushAppliedActionsEntry = (
  ledger: AppliedActionsEntry[],
  entry: AppliedActionsEntry,
  capacity = appliedActionsCapacity,
): AppliedActionsEntry[] => {
  const next = [...ledger, entry]
  return next.length > capacity ? next.slice(next.length - capacity) : next
}

// Module-level channels: the probe reports from React components and App's
// reducer wiring, both outside installStuckPaneForensics' closure.
let panelUnmountLedger: PanelUnmountEntry[] = []
let appliedActionsLedger: AppliedActionsEntry[] = []
let appStateTruthGetter: (() => ForensicsAppStateLike) | null = null

export const registerForensicsAppStateTruth = (
  getter: (() => ForensicsAppStateLike) | null,
) => {
  appStateTruthGetter = getter
}

export const recordPanelUnmountForForensics = (input: {
  tabId: string
  paneId: string
  activeAtUnmount: boolean
}) => {
  let dataLayerHasTab: boolean | null = null
  let dataLayerHasCard: boolean | null = null
  if (appStateTruthGetter) {
    try {
      const located = locateTabInAppState(appStateTruthGetter(), input.tabId)
      dataLayerHasTab = located.tabInLayout
      dataLayerHasCard = located.cardPresent
    } catch {
      // Truth interrogation must never break an unmount.
    }
  }
  panelUnmountLedger = pushPanelUnmountEntry(panelUnmountLedger, {
    atMs: Math.round(globalThis.performance?.now() ?? 0),
    tabId: input.tabId,
    paneId: input.paneId,
    activeAtUnmount: input.activeAtUnmount,
    dataLayerHasTab,
    dataLayerHasCard,
  })
}

export const recordAppliedActionsForForensics = (types: string[]) => {
  if (types.length === 0) {
    return
  }
  appliedActionsLedger = pushAppliedActionsEntry(appliedActionsLedger, {
    atMs: Math.round(globalThis.performance?.now() ?? 0),
    types,
  })
}

export const readPanelUnmountLedger = (): PanelUnmountEntry[] => panelUnmountLedger

export const readAppliedActionsLedger = (): AppliedActionsEntry[] => appliedActionsLedger

export const drainPanelUnmountLedgerForTest = (): PanelUnmountEntry[] => {
  const drained = panelUnmountLedger
  panelUnmountLedger = []
  return drained
}

export const hasSilentFocusLossSignature = (
  ledger: FocusLedgerEntry[],
  focusIsVacant: boolean,
): boolean => {
  if (!focusIsVacant || ledger.length === 0) {
    return false
  }
  return ledger[ledger.length - 1]!.kind === 'focusin'
}

const describeSingleElement = (element: ForensicsElementLike): string => {
  const tag = element.tagName.toLowerCase()
  const className =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`
      : ''
  const id = element.id ? `#${element.id}` : ''
  const tabId = element.getAttribute('data-pane-tab-id')
  const tabAttr = tabId ? `[data-pane-tab-id=${tabId}]` : ''
  return `${tag}${id}${className}${tabAttr}`
}

export const describeElementPath = (
  element: ForensicsElementLike | null,
  maxDepth = 5,
): string => {
  if (!element) {
    return '(null)'
  }
  const parts: string[] = []
  let cursor: ForensicsElementLike | null = element
  while (cursor && parts.length < maxDepth) {
    parts.push(describeSingleElement(cursor))
    cursor = cursor.parentElement
  }
  return parts.join(' > ')
}

// Unfocusable-cause interrogation (dump 07-09T09-16): every kick fired a real
// focusout (removal is silent — the element survived), which leaves exactly
// two mechanisms: the browser's focus fixup (something on the chain flipped
// unfocusable for an instant) or a window-level steal. The flip recovers
// within milliseconds, so the only place it can be caught is synchronously
// inside the focusout listener — walk the chain and name the flipped layer
// while it is still flipped.
export type UnfocusableCause = {
  kind: 'detached' | 'disabled' | 'hidden-attr' | 'inert' | 'display-none' | 'visibility-hidden'
  path: string
}

export const diagnoseUnfocusableCause = (
  element: (ForensicsElementLike & { isConnected?: boolean }) | null,
  getStyle: (el: ForensicsElementLike) => { display: string; visibility: string } | null,
): UnfocusableCause | null => {
  if (!element) {
    return null
  }
  if (element.isConnected === false) {
    return { kind: 'detached', path: describeElementPath(element) }
  }
  if (element.getAttribute('disabled') !== null) {
    return { kind: 'disabled', path: describeElementPath(element) }
  }
  let cursor: ForensicsElementLike | null = element
  while (cursor) {
    if (cursor.getAttribute('hidden') !== null) {
      return { kind: 'hidden-attr', path: describeElementPath(cursor) }
    }
    if (cursor.getAttribute('inert') !== null) {
      return { kind: 'inert', path: describeElementPath(cursor) }
    }
    const style = getStyle(cursor)
    if (style?.display === 'none') {
      return { kind: 'display-none', path: describeElementPath(cursor) }
    }
    if (style?.visibility === 'hidden') {
      return { kind: 'visibility-hidden', path: describeElementPath(cursor) }
    }
    cursor = cursor.parentElement
  }
  return null
}

// Normal routing: the event target and the layout hit are the same element or
// related by ancestry (pointer-events / precise-vs-container differences).
// Two unrelated subtrees mean the event system and the layout engine disagree
// about the same physical point — the misroute signature this whole
// investigation orbits around.
export const doTargetAndHitAgree = (
  target: ForensicsElementLike | null,
  hit: ForensicsElementLike | null,
): boolean => {
  if (!target || !hit) {
    return false
  }
  return target === hit || target.contains(hit) || hit.contains(target)
}

export type AutoDumpOptions = {
  windowMs: number
  threshold: number
  cooldownMs: number
}

export const defaultAutoDumpOptions: AutoDumpOptions = {
  windowMs: 10_000,
  threshold: 3,
  cooldownMs: 300_000,
}

export type AutoDumpState = {
  eventTimesMs: number[]
  lastDumpAtMs: number
}

export const shouldAutoDumpAfterRescueEvent = (
  state: AutoDumpState,
  nowMs: number,
  options: AutoDumpOptions = defaultAutoDumpOptions,
): { dump: boolean; next: AutoDumpState } => {
  const fresh = state.eventTimesMs.filter((atMs) => nowMs - atMs < options.windowMs)
  fresh.push(nowMs)
  const cooledDown = nowMs - state.lastDumpAtMs >= options.cooldownMs
  if (fresh.length >= options.threshold && cooledDown) {
    return { dump: true, next: { eventTimesMs: [], lastDumpAtMs: nowMs } }
  }
  return { dump: false, next: { eventTimesMs: fresh, lastDumpAtMs: state.lastDumpAtMs } }
}

// The composer's send-gate, projected from the DOM. A render stall and a
// silently-locked input look identical from focus/pointer/frame data alone —
// both leave a focusable textarea the user "can't do anything with". The gate
// signals (is the send button disabled while the textarea holds text? what is
// the placeholder telling the user? is the card streaming?) are what tell the
// two apart in a dump, so we capture them explicitly.
export type ComposerStateQuery = {
  hasShell: boolean
  streaming?: boolean
  textarea?: {
    present: boolean
    disabled: boolean
    hasText: boolean
    placeholder: string
  }
  sendButton?: {
    present: boolean
    disabled: boolean
  }
}

export type ComposerStateSummary = {
  present: boolean
  streaming: boolean
  textareaPresent: boolean
  textareaDisabled: boolean
  textareaHasText: boolean
  placeholder: string
  sendButtonPresent: boolean
  sendButtonDisabled: boolean
}

export const summarizeComposerState = (query: ComposerStateQuery): ComposerStateSummary => ({
  present: query.hasShell,
  streaming: query.streaming ?? false,
  textareaPresent: query.textarea?.present ?? false,
  textareaDisabled: query.textarea?.disabled ?? false,
  textareaHasText: query.textarea?.hasText ?? false,
  placeholder: query.textarea?.placeholder ?? '',
  sendButtonPresent: query.sendButton?.present ?? false,
  sendButtonDisabled: query.sendButton?.disabled ?? false,
})

export type RectSummary = { left: number; top: number; right: number; bottom: number }

export type ForensicsPaneSummary = {
  paneClassName: string
  tabs: Array<{ tabId: string; rect: RectSummary; className: string }>
  panels: Array<{
    className: string
    hidden: boolean
    rect: RectSummary
    hitTestRepairCount: number
    rescueUnhandledCount: number
    focusExhaustedCount: number
    // Guard reclaims: focus settled on the textarea and was silently stolen
    // again (no blur). >0 here + a trailing focusin in focusLedger = the
    // silent-steal class, not a click-routing failure.
    focusGuardReclaimCount: number
    composer?: ComposerStateSummary
  }>
}

export type ForensicsSnapshot = {
  schema: 'chill-vibe.stuck-pane-forensics.v1'
  reason: string
  nowIso: string
  activeElementPath: string
  documentHasFocus: boolean
  visibilityState: string
  windowSize: { width: number; height: number }
  panes: ForensicsPaneSummary[]
  hitGrid: Array<{ x: number; y: number; path: string }>
  pointerLedger: PointerLedgerEntry[]
  rafTimestampsMs: number[]
  rescueEventTimesMs: number[]
  focusLedger?: FocusLedgerEntry[]
  silentFocusLoss?: boolean
  reactiveFocusKickCount?: number
  focusMethodCalls?: FocusMethodCallEntry[]
  composerAttrMutations?: ComposerAttributeMutationEntry[]
  panelUnmounts?: PanelUnmountEntry[]
  appliedActions?: AppliedActionsEntry[]
}

export type ForensicsSnapshotInput = Omit<ForensicsSnapshot, 'schema'>

export const assembleForensicsSnapshot = (input: ForensicsSnapshotInput): ForensicsSnapshot => ({
  schema: 'chill-vibe.stuck-pane-forensics.v1',
  ...input,
})

// ── runtime (thin DOM layer over the pure core) ─────────────────────────────

export const forensicsRescueEventName = 'chill-vibe:forensics-rescue-event'

export const notifyForensicsRescueEvent = (kind: string) => {
  window.dispatchEvent(new CustomEvent(forensicsRescueEventName, { detail: { kind } }))
}

const roundRect = (rect: DOMRect): RectSummary => ({
  left: Math.round(rect.left),
  top: Math.round(rect.top),
  right: Math.round(rect.right),
  bottom: Math.round(rect.bottom),
})

const readCount = (element: Element | null, attribute: string): number =>
  element instanceof HTMLElement ? Number(element.dataset[attribute] ?? '0') : 0

const readComposerState = (shell: HTMLElement | null): ComposerStateSummary => {
  if (!shell) {
    return summarizeComposerState({ hasShell: false })
  }
  const textarea = shell.querySelector<HTMLTextAreaElement>('textarea.control.textarea')
  // The send button is the only primary IconButton in the composer action row;
  // its disabled state IS the projection of `sendDisabled`, the exact gate that
  // silently swallows Enter/click when a message can't be sent.
  const sendButton = shell.querySelector<HTMLButtonElement>(
    '.composer-actions button.icon-button.is-primary',
  )
  return summarizeComposerState({
    hasShell: true,
    streaming: shell.classList.contains('is-streaming'),
    textarea: textarea
      ? {
          present: true,
          disabled: textarea.disabled,
          hasText: textarea.value.trim().length > 0,
          placeholder: textarea.placeholder,
        }
      : { present: false, disabled: false, hasText: false, placeholder: '' },
    sendButton: sendButton
      ? { present: true, disabled: sendButton.disabled }
      : { present: false, disabled: false },
  })
}

const collectPanes = (): ForensicsPaneSummary[] =>
  [...document.querySelectorAll('.pane-view')].map((pane) => ({
    paneClassName: pane.className,
    tabs: [...pane.querySelectorAll<HTMLButtonElement>('button[data-pane-tab-id]')].map(
      (button) => ({
        tabId: button.dataset.paneTabId ?? '',
        rect: roundRect(button.getBoundingClientRect()),
        className: button.className,
      }),
    ),
    panels: [...pane.querySelectorAll<HTMLElement>('.pane-tab-panel')].map((panel) => {
      const shell = panel.querySelector<HTMLElement>('.card-shell')
      return {
        className: panel.className,
        hidden: panel.hidden,
        rect: roundRect(panel.getBoundingClientRect()),
        hitTestRepairCount: readCount(panel, 'hitTestRepairCount') + readCount(shell, 'hitTestRepairCount'),
        rescueUnhandledCount: readCount(shell, 'composerRescueUnhandledCount'),
        focusExhaustedCount: readCount(shell, 'composerFocusExhaustedCount'),
        focusGuardReclaimCount: readCount(shell, 'composerFocusGuardReclaimCount'),
        composer: readComposerState(shell),
      }
    }),
  }))

const collectHitGrid = (columns = 12, rows = 8): Array<{ x: number; y: number; path: string }> => {
  const grid: Array<{ x: number; y: number; path: string }> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = Math.round(((column + 0.5) / columns) * window.innerWidth)
      const y = Math.round(((row + 0.5) / rows) * window.innerHeight)
      grid.push({
        x,
        y,
        path: describeElementPath(document.elementFromPoint(x, y) as ForensicsElementLike | null, 3),
      })
    }
  }
  return grid
}

type ForensicsBridge = {
  writeForensicsDump?: (json: string) => Promise<string | null>
}

const persistSnapshot = async (snapshot: ForensicsSnapshot) => {
  const json = JSON.stringify(snapshot, null, 2)
  const bridge = (window as { electronAPI?: ForensicsBridge }).electronAPI
  if (bridge?.writeForensicsDump) {
    try {
      const writtenPath = await bridge.writeForensicsDump(json)
      console.warn(`[forensics] stuck-pane snapshot written: ${writtenPath ?? '(unknown path)'}`)
      return
    } catch (error) {
      console.error('[forensics] failed to persist snapshot via bridge', error)
    }
  }
  console.warn('[forensics] snapshot (no desktop bridge; copy from console):', json)
}

export const installStuckPaneForensics = () => {
  let ledger: PointerLedgerEntry[] = []
  let autoDumpState: AutoDumpState = { eventTimesMs: [], lastDumpAtMs: -Infinity }
  let rafTimestamps: number[] = []
  let rafHandle = 0

  // A permanently running rAF heartbeat would defeat backgroundThrottling's
  // point; a sparse timer that samples a single frame keeps the cost near
  // zero while still revealing "frames have stopped being produced".
  const sampleFrame = () => {
    rafHandle = window.requestAnimationFrame((timestamp) => {
      rafTimestamps = [...rafTimestamps.slice(-9), Math.round(timestamp)]
      // Published for the main-process frame-stall watchdog: a visible window
      // whose value stops advancing is a compositor stall, and main-side
      // timers keep polling even when renderer timers are throttled.
      ;(window as { __chillVibeLastFrameTimestamp?: number }).__chillVibeLastFrameTimestamp =
        Math.round(timestamp)
    })
  }
  const heartbeatTimer = window.setInterval(sampleFrame, 1_000)

  const recordPointer = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    ledger = pushPointerLedgerEntry(ledger, {
      atMs: Math.round(performance.now()),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      button: event.button,
      targetPath: describeElementPath(target as ForensicsElementLike | null),
      hitPath: describeElementPath(hit as ForensicsElementLike | null),
      agree: doTargetAndHitAgree(
        target as ForensicsElementLike | null,
        hit as ForensicsElementLike | null,
      ),
    })
  }

  // Focus transitions: silent removals still show as a trailing focusin, while
  // React commit deletion can dispatch focusout first and detach the target by
  // the following microtask (dump 07-10T04-23).
  let focusLedger: FocusLedgerEntry[] = []
  const recordFocusIn = (event: FocusEvent) => {
    focusLedger = pushFocusLedgerEntry(focusLedger, {
      atMs: Math.round(performance.now()),
      kind: 'focusin',
      path: describeElementPath(event.target as ForensicsElementLike | null),
    })
  }
  const recordFocusOut = (event: FocusEvent) => {
    const relatedPath = describeElementPath(event.relatedTarget as ForensicsElementLike | null)
    const entry: FocusLedgerEntry = {
      atMs: Math.round(performance.now()),
      kind: 'focusout',
      path: describeElementPath(event.target as ForensicsElementLike | null),
      // Where focus went. '(null)' = nowhere: the programmatic-kick fingerprint.
      relatedPath,
    }
    if (relatedPath === '(null)') {
      // Interrogate the kick in place: the flipped attribute is still in
      // effect during this synchronous dispatch, and a fixup triggered from a
      // commit carries the flipper in the current stack.
      entry.docHasFocus = document.hasFocus()
      entry.unfocusableCause =
        event.target instanceof HTMLElement
          ? diagnoseUnfocusableCause(
              event.target as unknown as ForensicsElementLike & { isConnected?: boolean },
              (el) => {
                const style = window.getComputedStyle(el as unknown as Element)
                return { display: style.display, visibility: style.visibility }
              },
            )
          : null
      entry.stackTop = summarizeCallStack(new Error('focusout-trace').stack ?? undefined, 6)
      if (event.target instanceof HTMLElement) {
        const focusTarget = event.target
        entry.connectedAtDispatch = focusTarget.isConnected
        queueMicrotask(() => {
          entry.connectedAfterMicrotask = focusTarget.isConnected
          if (focusTarget.isConnected) {
            return
          }
          let detachedRoot: HTMLElement = focusTarget
          while (detachedRoot.parentElement instanceof HTMLElement) {
            detachedRoot = detachedRoot.parentElement
          }
          entry.detachedRootPath = describeElementPath(
            detachedRoot as unknown as ForensicsElementLike,
            1,
          )
          entry.detachedTargetPath = describeElementPath(
            focusTarget as unknown as ForensicsElementLike,
            12,
          )
        })
      }
    }
    focusLedger = pushFocusLedgerEntry(focusLedger, entry)
  }

  // Programmatic focus/blur callers, with stack tops. A reactive kick can only
  // come from one of these (or an attribute flip, observed below), so the next
  // dump names the culprit instead of us inferring it from timing.
  let focusMethodCalls: FocusMethodCallEntry[] = []
  const originalBlur = HTMLElement.prototype.blur
  const originalFocus = HTMLElement.prototype.focus
  HTMLElement.prototype.blur = function blurWithForensics(this: HTMLElement) {
    focusMethodCalls = pushFocusMethodCallEntry(focusMethodCalls, {
      atMs: Math.round(performance.now()),
      kind: 'blur',
      path: describeElementPath(this as unknown as ForensicsElementLike),
      stackTop: summarizeCallStack(new Error('blur-trace').stack ?? undefined, 6),
    })
    originalBlur.call(this)
  }
  HTMLElement.prototype.focus = function focusWithForensics(
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    originalFocus.call(this, options)
    focusMethodCalls = pushFocusMethodCallEntry(focusMethodCalls, {
      atMs: Math.round(performance.now()),
      kind: 'focus',
      path: describeElementPath(this as unknown as ForensicsElementLike),
      // false while the self-heals are calling = the composer is unfocusable
      // right now (disabled/hidden/inert somewhere on its chain).
      landed: document.activeElement === this,
      stackTop: summarizeCallStack(new Error('focus-trace').stack ?? undefined, 6),
    })
  }

  // Attribute flips on the composer chain kick focus via the browser's focus
  // fixup without any blur() call; pair them with the ledger timestamps.
  let composerAttrMutations: ComposerAttributeMutationEntry[] = []
  const attributeObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== 'attributes' || !(record.target instanceof Element)) {
        continue
      }
      const target = record.target
      const isComposerRelated =
        target.tagName === 'TEXTAREA' ||
        target.closest('.composer') !== null ||
        composerChainLayerClasses.some((layer) => target.classList.contains(layer))
      if (!isComposerRelated) {
        continue
      }
      const attributeName = record.attributeName ?? ''
      const newValue = target.getAttribute(attributeName)
      if (
        !shouldRecordComposerAttributeMutation({
          attributeName,
          oldValue: record.oldValue,
          newValue,
        })
      ) {
        continue
      }
      composerAttrMutations = pushComposerAttributeMutationEntry(composerAttrMutations, {
        atMs: Math.round(performance.now()),
        attr: attributeName,
        value: newValue,
        path: describeElementPath(target as ForensicsElementLike | null),
      })
    }
  })
  attributeObserver.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['disabled', 'hidden', 'inert', 'readonly', 'class', 'style'],
  })

  const capture = (reason: string) => {
    const focusIsVacant =
      document.activeElement === null || document.activeElement === document.body
    const snapshot = assembleForensicsSnapshot({
      reason,
      nowIso: new Date().toISOString(),
      activeElementPath: describeElementPath(
        document.activeElement as ForensicsElementLike | null,
      ),
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      windowSize: { width: window.innerWidth, height: window.innerHeight },
      panes: collectPanes(),
      hitGrid: collectHitGrid(),
      pointerLedger: ledger,
      rafTimestampsMs: rafTimestamps,
      rescueEventTimesMs: autoDumpState.eventTimesMs,
      focusLedger,
      silentFocusLoss: hasSilentFocusLossSignature(focusLedger, focusIsVacant),
      reactiveFocusKickCount: countReactiveFocusKicks(focusLedger),
      focusMethodCalls,
      composerAttrMutations,
      panelUnmounts: readPanelUnmountLedger(),
      appliedActions: readAppliedActionsLedger(),
    })
    void persistSnapshot(snapshot)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key === 'F9') {
      event.preventDefault()
      capture('hotkey')
    }
  }

  const handleRescueEvent = (event: Event) => {
    const kind = (event as CustomEvent<{ kind?: string }>).detail?.kind ?? 'unknown'
    const decision = shouldAutoDumpAfterRescueEvent(autoDumpState, Date.now())
    autoDumpState = decision.next
    if (decision.dump) {
      capture(`auto:${kind}`)
    }
  }

  document.addEventListener('pointerdown', recordPointer, true)
  document.addEventListener('focusin', recordFocusIn, true)
  document.addEventListener('focusout', recordFocusOut, true)
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener(forensicsRescueEventName, handleRescueEvent)

  return () => {
    document.removeEventListener('pointerdown', recordPointer, true)
    document.removeEventListener('focusin', recordFocusIn, true)
    document.removeEventListener('focusout', recordFocusOut, true)
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener(forensicsRescueEventName, handleRescueEvent)
    window.clearInterval(heartbeatTimer)
    window.cancelAnimationFrame(rafHandle)
    HTMLElement.prototype.blur = originalBlur
    HTMLElement.prototype.focus = originalFocus
    attributeObserver.disconnect()
  }
}
