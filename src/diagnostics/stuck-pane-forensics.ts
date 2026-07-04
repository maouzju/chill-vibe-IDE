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

  const capture = (reason: string) => {
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
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener(forensicsRescueEventName, handleRescueEvent)

  return () => {
    document.removeEventListener('pointerdown', recordPointer, true)
    window.removeEventListener('keydown', handleKeyDown)
    window.removeEventListener(forensicsRescueEventName, handleRescueEvent)
    window.clearInterval(heartbeatTimer)
    window.cancelAnimationFrame(rafHandle)
  }
}
