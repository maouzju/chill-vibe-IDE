import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  assembleForensicsSnapshot,
  describeElementPath,
  doTargetAndHitAgree,
  focusLedgerCapacity,
  hasSilentFocusLossSignature,
  pointerLedgerCapacity,
  pushFocusLedgerEntry,
  pushPointerLedgerEntry,
  shouldAutoDumpAfterRescueEvent,
  summarizeComposerState,
  type ComposerStateQuery,
  type FocusLedgerEntry,
  type ForensicsElementLike,
  type PointerLedgerEntry,
} from '../src/diagnostics/stuck-pane-forensics'

// Minimal structural stand-ins for DOM elements so the decision core stays
// node:test-able; production passes real Elements (structurally compatible).
type FakeNode = ForensicsElementLike & {
  children: FakeNode[]
  parent: FakeNode | null
}

const makeNode = (
  tagName: string,
  options?: { className?: string; id?: string; attrs?: Record<string, string> },
): FakeNode => {
  const node: FakeNode = {
    tagName: tagName.toUpperCase(),
    className: options?.className ?? '',
    id: options?.id ?? '',
    parentElement: null,
    children: [],
    parent: null,
    getAttribute: (name: string) => options?.attrs?.[name] ?? null,
    contains: (other) => {
      let cursor: FakeNode | null = other as FakeNode | null
      while (cursor) {
        if (cursor === node) {
          return true
        }
        cursor = cursor.parent
      }
      return false
    },
  }
  return node
}

const appendChild = (parent: FakeNode, child: FakeNode) => {
  parent.children.push(child)
  child.parent = parent
  child.parentElement = parent
  return child
}

const ledgerEntry = (atMs: number): PointerLedgerEntry => ({
  atMs,
  x: 10,
  y: 10,
  button: 0,
  targetPath: 't',
  hitPath: 'h',
  agree: true,
})

test('pointer ledger keeps only the newest entries up to capacity, in order', () => {
  let ledger: PointerLedgerEntry[] = []
  for (let index = 0; index < pointerLedgerCapacity + 5; index += 1) {
    ledger = pushPointerLedgerEntry(ledger, ledgerEntry(index))
  }
  assert.equal(ledger.length, pointerLedgerCapacity)
  assert.equal(ledger[0]?.atMs, 5, 'oldest entries beyond capacity must be dropped')
  assert.equal(ledger.at(-1)?.atMs, pointerLedgerCapacity + 4)
})

test('target and hit agree when they are the same element or related by ancestry', () => {
  const root = makeNode('div', { className: 'pane-view' })
  const button = appendChild(root, makeNode('button', { className: 'pane-tab' }))
  const icon = appendChild(button, makeNode('svg', { className: 'pane-tab-icon' }))

  assert.equal(doTargetAndHitAgree(button, button), true)
  assert.equal(doTargetAndHitAgree(icon, button), true, 'hit resolving to an ancestor of target is normal routing')
  assert.equal(doTargetAndHitAgree(button, icon), true, 'target above the precise hit is normal routing')
})

test('target and hit disagree across unrelated subtrees — the misroute signature', () => {
  const paneA = makeNode('div', { className: 'pane-view' })
  const buttonA = appendChild(paneA, makeNode('button', { className: 'pane-tab' }))
  const paneB = makeNode('div', { className: 'pane-view' })
  const textareaB = appendChild(paneB, makeNode('textarea', { className: 'composer-input' }))

  assert.equal(doTargetAndHitAgree(buttonA, textareaB), false)
  assert.equal(doTargetAndHitAgree(null, buttonA), false)
  assert.equal(doTargetAndHitAgree(buttonA, null), false)
})

test('element paths read as a compact ancestor chain with identifying hooks', () => {
  const pane = makeNode('div', { className: 'pane-view' })
  const strip = appendChild(pane, makeNode('div', { className: 'pane-tab-strip' }))
  const button = appendChild(
    strip,
    makeNode('button', { className: 'pane-tab is-active', attrs: { 'data-pane-tab-id': 'tab-42' } }),
  )

  const described = describeElementPath(button)
  assert.match(described, /button\.pane-tab/)
  assert.match(described, /tab-42/, 'data-pane-tab-id must surface in the path for triage')
  assert.match(described, /pane-tab-strip/)
  assert.equal(describeElementPath(null), '(null)')
})

test('element path depth is bounded', () => {
  let cursor = makeNode('div', { className: 'level-0' })
  const leafParentChain = [cursor]
  for (let index = 1; index < 12; index += 1) {
    cursor = appendChild(cursor, makeNode('div', { className: `level-${index}` }))
    leafParentChain.push(cursor)
  }
  const described = describeElementPath(cursor)
  assert.ok(described.includes('level-11'))
  assert.ok(!described.includes('level-0'), 'the chain must truncate instead of walking to the root forever')
})

test('auto dump fires only after repeated rescue events inside the window and honors the cooldown', () => {
  const opts = { windowMs: 10_000, threshold: 3, cooldownMs: 300_000 }
  let state = { eventTimesMs: [] as number[], lastDumpAtMs: -Infinity }

  let decision = shouldAutoDumpAfterRescueEvent(state, 1_000, opts)
  assert.equal(decision.dump, false)
  state = decision.next

  decision = shouldAutoDumpAfterRescueEvent(state, 2_000, opts)
  assert.equal(decision.dump, false)
  state = decision.next

  decision = shouldAutoDumpAfterRescueEvent(state, 3_000, opts)
  assert.equal(decision.dump, true, 'third rescue event within 10s is the stuck signature')
  state = decision.next

  decision = shouldAutoDumpAfterRescueEvent(state, 4_000, opts)
  assert.equal(decision.dump, false, 'cooldown must suppress a follow-up dump')

  decision = shouldAutoDumpAfterRescueEvent(state, 3_000 + 300_001, opts)
  state = decision.next
  decision = shouldAutoDumpAfterRescueEvent(state, 3_000 + 300_002, opts)
  state = decision.next
  decision = shouldAutoDumpAfterRescueEvent(state, 3_000 + 300_003, opts)
  assert.equal(decision.dump, true, 'after the cooldown a fresh burst dumps again')
})

test('events older than the window slide out of the auto dump count', () => {
  const opts = { windowMs: 10_000, threshold: 3, cooldownMs: 300_000 }
  let state = { eventTimesMs: [] as number[], lastDumpAtMs: -Infinity }

  state = shouldAutoDumpAfterRescueEvent(state, 1_000, opts).next
  state = shouldAutoDumpAfterRescueEvent(state, 2_000, opts).next
  const decision = shouldAutoDumpAfterRescueEvent(state, 20_000, opts)
  assert.equal(decision.dump, false, 'two stale events plus one fresh must not trip the threshold')
})

test('composer state summary exposes the send-gate signals that distinguish a locked input from a render stall', () => {
  // The forensic dumps could never tell "input focused but send silently
  // swallowed" apart from a real render stall, because nothing captured the
  // composer's send-gate. This models the DOM the summary must read.
  const query: ComposerStateQuery = {
    hasShell: true,
    streaming: true,
    textarea: {
      present: true,
      disabled: false,
      hasText: true,
      placeholder: '',
    },
    sendButton: {
      present: true,
      disabled: true,
    },
  }

  const summary = summarizeComposerState(query)
  assert.equal(summary.present, true)
  assert.equal(summary.streaming, true)
  assert.equal(summary.textareaPresent, true)
  assert.equal(summary.textareaDisabled, false)
  assert.equal(summary.textareaHasText, true)
  assert.equal(summary.placeholder, '')
  assert.equal(summary.sendButtonPresent, true)
  assert.equal(
    summary.sendButtonDisabled,
    true,
    'send button disabled while the textarea is focusable and holds text is the "silently locked input" signature',
  )
})

test('composer state summary reports absence cleanly when no composer is mounted', () => {
  const summary = summarizeComposerState({ hasShell: false })
  assert.equal(summary.present, false)
  assert.equal(summary.textareaPresent, false)
  assert.equal(summary.sendButtonPresent, false)
})

test('the snapshot assembles every forensic section from injected collectors', () => {
  const snapshot = assembleForensicsSnapshot({
    reason: 'hotkey',
    nowIso: '2026-07-02T12:00:00.000Z',
    activeElementPath: 'textarea.composer-input > div.composer',
    documentHasFocus: true,
    visibilityState: 'visible',
    windowSize: { width: 1400, height: 900 },
    panes: [
      {
        paneClassName: 'pane-view',
        tabs: [{ tabId: 'a', rect: { left: 0, top: 0, right: 100, bottom: 30 }, className: 'pane-tab is-active' }],
        panels: [
          {
            className: 'pane-tab-panel is-active',
            hidden: false,
            rect: { left: 0, top: 30, right: 500, bottom: 800 },
            hitTestRepairCount: 2,
            rescueUnhandledCount: 1,
            focusExhaustedCount: 0,
            focusGuardReclaimCount: 0,
            composer: {
              present: true,
              streaming: true,
              textareaPresent: true,
              textareaDisabled: false,
              textareaHasText: true,
              placeholder: '',
              sendButtonPresent: true,
              sendButtonDisabled: true,
            },
          },
        ],
      },
    ],
    hitGrid: [{ x: 10, y: 10, path: 'div.pane-content' }],
    pointerLedger: [ledgerEntry(123)],
    rafTimestampsMs: [16.6, 33.2],
    rescueEventTimesMs: [1_000],
  })

  assert.equal(snapshot.schema, 'chill-vibe.stuck-pane-forensics.v1')
  assert.equal(snapshot.reason, 'hotkey')
  assert.equal(snapshot.activeElementPath, 'textarea.composer-input > div.composer')
  assert.equal(snapshot.panes.length, 1)
  assert.equal(snapshot.panes[0]?.panels[0]?.composer?.sendButtonDisabled, true)
  assert.equal(snapshot.pointerLedger[0]?.atMs, 123)
  assert.equal(snapshot.hitGrid.length, 1)
  assert.deepEqual(snapshot.rafTimestampsMs, [16.6, 33.2])
})

// ── focus ledger: the silent-loss signature (dump 07-08T04-05) ──────────────
// Seven presses land on the textarea, focus settles each time, yet the dump
// shows activeElement=<body> with every rescue counter 0. Whatever stole the
// focus fired no blur — unmount/remount and disable both do that — so the
// dump needs a focusin/focusout ledger: a trailing focusin with no matching
// focusout while focus sits vacant is the silent-steal fingerprint.

const focusEntry = (atMs: number, kind: 'focusin' | 'focusout'): FocusLedgerEntry => ({
  atMs,
  kind,
  path: 'textarea.control.textarea > div.composer',
})

test('focus ledger keeps only the newest entries up to capacity, in order', () => {
  let ledger: FocusLedgerEntry[] = []
  for (let index = 0; index < focusLedgerCapacity + 4; index += 1) {
    ledger = pushFocusLedgerEntry(ledger, focusEntry(index, index % 2 === 0 ? 'focusin' : 'focusout'))
  }
  assert.equal(ledger.length, focusLedgerCapacity)
  assert.equal(ledger[0]?.atMs, 4)
  assert.equal(ledger.at(-1)?.atMs, focusLedgerCapacity + 3)
})

test('a trailing focusin with vacant focus is the silent-loss signature', () => {
  const ledger = [focusEntry(1, 'focusin')]
  assert.equal(hasSilentFocusLossSignature(ledger, true), true)
})

test('a trailing focusout is a normal blur — rescues had their chance, no silent loss', () => {
  const ledger = [focusEntry(1, 'focusin'), focusEntry(2, 'focusout')]
  assert.equal(hasSilentFocusLossSignature(ledger, true), false)
})

test('no silent loss is reported while focus is actually held or the ledger is empty', () => {
  assert.equal(hasSilentFocusLossSignature([focusEntry(1, 'focusin')], false), false)
  assert.equal(hasSilentFocusLossSignature([], true), false)
})

test('the snapshot carries the focus ledger and the silent-loss verdict', () => {
  const snapshot = assembleForensicsSnapshot({
    reason: 'hotkey',
    nowIso: '2026-07-08T12:00:00.000Z',
    activeElementPath: 'body > html',
    documentHasFocus: true,
    visibilityState: 'visible',
    windowSize: { width: 1400, height: 900 },
    panes: [],
    hitGrid: [],
    pointerLedger: [],
    rafTimestampsMs: [],
    rescueEventTimesMs: [],
    focusLedger: [focusEntry(500, 'focusin')],
    silentFocusLoss: true,
  })
  assert.equal(snapshot.focusLedger?.[0]?.atMs, 500)
  assert.equal(snapshot.silentFocusLoss, true)
})

test('the forensics runtime records focusin/focusout transitions', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src', 'diagnostics', 'stuck-pane-forensics.ts'),
    'utf8',
  )
  assert.match(source, /addEventListener\('focusin'/, 'runtime must observe focusin')
  assert.match(source, /addEventListener\('focusout'/, 'runtime must observe focusout')
  assert.match(source, /silentFocusLoss/, 'capture must include the silent-loss verdict')
})

// ── wiring assertions ───────────────────────────────────────────────────────

test('the forensics runtime is installed at the app root', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'App.tsx'), 'utf8')
  assert.match(source, /installStuckPaneForensics/)
})

test('rescue paths announce themselves to the forensics ledger', async () => {
  const chatCard = await readFile(path.join(process.cwd(), 'src', 'components', 'ChatCard.tsx'), 'utf8')
  assert.match(
    chatCard,
    /notifyForensicsRescueEvent\('composer-rescue-unhandled'\)/,
    'the unhandled dead end is the primary auto-dump trigger',
  )
  const paneView = await readFile(path.join(process.cwd(), 'src', 'components', 'PaneView.tsx'), 'utf8')
  assert.match(
    paneView,
    /notifyForensicsRescueEvent\('tab-rescue'\)/,
    'a firing tab rescue is a confirmed misroute and must count toward auto-dump',
  )
})

test('main process persists forensics dumps and enables devtools via F12', async () => {
  const main = await readFile(path.join(process.cwd(), 'electron', 'main.ts'), 'utf8')
  assert.match(main, /diagnostics:write-forensics/)
  assert.match(main, /toggleDevTools/)
  const preload = await readFile(path.join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
  assert.match(preload, /writeForensicsDump/)
})
