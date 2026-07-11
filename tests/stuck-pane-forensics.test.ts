import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

import {
  assembleForensicsSnapshot,
  composerAttributeMutationCapacity,
  composerChainLayerClasses,
  countReactiveFocusKicks,
  describeElementPath,
  diagnoseUnfocusableCause,
  doTargetAndHitAgree,
  focusLedgerCapacity,
  focusMethodCallCapacity,
  hasSilentFocusLossSignature,
  pointerLedgerCapacity,
  pushComposerAttributeMutationEntry,
  pushFocusLedgerEntry,
  pushFocusMethodCallEntry,
  pushPointerLedgerEntry,
  shouldAutoDumpAfterRescueEvent,
  shouldRecordComposerAttributeMutation,
  summarizeCallStack,
  summarizeComposerState,
  type ComposerAttributeMutationEntry,
  type ComposerStateQuery,
  type FocusLedgerEntry,
  type FocusMethodCallEntry,
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

// ── reactive focus kick (dump 07-08T06-22) ──────────────────────────────────
// The user clicks the textarea, focusin lands, and 5-10ms later a focusout
// fires with NO user gesture and no destination element — something reacts to
// the focus itself and kicks it back out. Every focus() the self-heals issue
// afterwards fails silently, so all counters read 0. The ledger must record
// where focus went on focusout (relatedTarget) and the dump must count these
// reactive kicks so the signature is a first-class verdict, not a manual diff.

test('a focusin followed within the kick window by a focusout to nowhere counts as a reactive kick', () => {
  const ledger: FocusLedgerEntry[] = [
    { atMs: 1_000, kind: 'focusin', path: 'textarea.control.textarea > div.composer' },
    { atMs: 1_008, kind: 'focusout', path: 'textarea.control.textarea > div.composer', relatedPath: '(null)' },
    { atMs: 2_000, kind: 'focusin', path: 'textarea.control.textarea > div.composer' },
    { atMs: 2_006, kind: 'focusout', path: 'textarea.control.textarea > div.composer', relatedPath: '(null)' },
  ]
  assert.equal(countReactiveFocusKicks(ledger), 2)
})

// Dump 07-09T09-16: every real kick pair reads focusin on
// `textarea.control.textarea.focus-visible > …` but focusout on
// `textarea.control.textarea > …` — the browser drops :focus-visible (and its
// class mirror) the instant focus leaves, so a strict path comparison misses
// every kick and the verdict counter stays 0 while the ledger is full of them.
test('focus-visible class churn between focusin and focusout does not hide a kick', () => {
  const ledger: FocusLedgerEntry[] = [
    {
      atMs: 1_000,
      kind: 'focusin',
      path: 'textarea.control.textarea.focus-visible > div.composer-input-row > div.composer',
    },
    {
      atMs: 1_008,
      kind: 'focusout',
      path: 'textarea.control.textarea > div.composer-input-row > div.composer',
      relatedPath: '(null)',
    },
  ]
  assert.equal(countReactiveFocusKicks(ledger), 1)
})

test('a focusout that hands focus to a real element is a deliberate move, not a kick', () => {
  const ledger: FocusLedgerEntry[] = [
    { atMs: 1_000, kind: 'focusin', path: 'textarea.control.textarea > div.composer' },
    {
      atMs: 1_010,
      kind: 'focusout',
      path: 'textarea.control.textarea > div.composer',
      relatedPath: 'button.pane-tab > div.pane-tab-bar',
    },
  ]
  assert.equal(countReactiveFocusKicks(ledger), 0)
})

test('a focusout hundreds of ms after focusin is user pacing, not a reactive kick', () => {
  const ledger: FocusLedgerEntry[] = [
    { atMs: 1_000, kind: 'focusin', path: 'textarea.control.textarea > div.composer' },
    { atMs: 1_400, kind: 'focusout', path: 'textarea.control.textarea > div.composer', relatedPath: '(null)' },
  ]
  assert.equal(countReactiveFocusKicks(ledger), 0)
})

test('legacy ledger entries without relatedPath never count as kicks', () => {
  const ledger: FocusLedgerEntry[] = [
    { atMs: 1_000, kind: 'focusin', path: 'textarea.control.textarea > div.composer' },
    { atMs: 1_008, kind: 'focusout', path: 'textarea.control.textarea > div.composer' },
  ]
  assert.equal(countReactiveFocusKicks(ledger), 0)
})

// ── unfocusable-cause snapshot on focusout-to-nowhere ───────────────────────
// Dump 07-09T09-16 narrowed the kick mechanism: every kick DID fire focusout
// (removal is silent, so the element survived) — meaning either the browser's
// focus fixup ran (something on the chain went unfocusable for an instant) or
// the OS window lost focus. Both culprits recover before the next dump, so the
// only way to catch them is to interrogate the chain SYNCHRONOUSLY inside the
// focusout listener, while the flipped attribute is still in effect.

test('a connected, enabled, visible element has no unfocusable cause', () => {
  const shell = makeNode('article', { className: 'card-shell' })
  const composer = appendChild(shell, makeNode('div', { className: 'composer' }))
  const textarea = appendChild(composer, makeNode('textarea', { className: 'control textarea' }))
  assert.equal(
    diagnoseUnfocusableCause(textarea, () => ({ display: 'block', visibility: 'visible' })),
    null,
  )
})

test('a detached element reports detached', () => {
  const textarea = makeNode('textarea', { className: 'control textarea' })
  ;(textarea as { isConnected?: boolean }).isConnected = false
  const cause = diagnoseUnfocusableCause(textarea, () => null)
  assert.equal(cause?.kind, 'detached')
})

test('a disabled element reports disabled on itself', () => {
  const composer = makeNode('div', { className: 'composer' })
  const textarea = appendChild(
    composer,
    makeNode('textarea', { className: 'control textarea', attrs: { disabled: '' } }),
  )
  const cause = diagnoseUnfocusableCause(textarea, () => ({ display: 'block', visibility: 'visible' }))
  assert.equal(cause?.kind, 'disabled')
  assert.match(cause?.path ?? '', /textarea/)
})

test('a hidden or inert ancestor reports the flipped layer, not the element', () => {
  const panel = makeNode('div', { className: 'pane-tab-panel', attrs: { hidden: '' } })
  const composer = appendChild(panel, makeNode('div', { className: 'composer' }))
  const textarea = appendChild(composer, makeNode('textarea', { className: 'control textarea' }))
  const cause = diagnoseUnfocusableCause(textarea, () => ({ display: 'block', visibility: 'visible' }))
  assert.equal(cause?.kind, 'hidden-attr')
  assert.match(cause?.path ?? '', /pane-tab-panel/)

  const inertShell = makeNode('article', { className: 'card-shell', attrs: { inert: '' } })
  const inertComposer = appendChild(inertShell, makeNode('div', { className: 'composer' }))
  const inertTextarea = appendChild(inertComposer, makeNode('textarea', { className: 'control textarea' }))
  const inertCause = diagnoseUnfocusableCause(inertTextarea, () => ({ display: 'block', visibility: 'visible' }))
  assert.equal(inertCause?.kind, 'inert')
  assert.match(inertCause?.path ?? '', /card-shell/)
})

test('a display:none or visibility:hidden ancestor reports the styled layer', () => {
  const shell = makeNode('article', { className: 'card-shell' })
  const composer = appendChild(shell, makeNode('div', { className: 'composer' }))
  const textarea = appendChild(composer, makeNode('textarea', { className: 'control textarea' }))
  const cause = diagnoseUnfocusableCause(textarea, (el) =>
    el === shell
      ? { display: 'none', visibility: 'visible' }
      : { display: 'block', visibility: 'visible' },
  )
  assert.equal(cause?.kind, 'display-none')
  assert.match(cause?.path ?? '', /card-shell/)

  const visCause = diagnoseUnfocusableCause(textarea, (el) =>
    el === composer
      ? { display: 'block', visibility: 'hidden' }
      : { display: 'block', visibility: 'visible' },
  )
  assert.equal(visCause?.kind, 'visibility-hidden')
  assert.match(visCause?.path ?? '', /composer/)
})

test('the forensics runtime interrogates focusout-to-nowhere in place', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src', 'diagnostics', 'stuck-pane-forensics.ts'),
    'utf8',
  )
  assert.match(source, /docHasFocus/, 'focusout-to-nowhere must record document.hasFocus() to split window-level steals (IME/system) from DOM-level fixup')
  assert.match(source, /diagnoseUnfocusableCause\(/, 'focusout-to-nowhere must snapshot the unfocusable cause while the flip is still live')
  assert.match(source, /focusout-trace/, 'focusout-to-nowhere must record a stack top — a synchronous fixup carries the flipping commit in its frames')
})

// ── attribute-mutation ledger coverage ──────────────────────────────────────
// Dump 07-09T09-16 blind spot: the ledger only admitted TEXTAREA, .composer
// descendants, and pane-tab-panel — card-footer, card-shell, split-child,
// pane-content and friends could flip display-affecting attributes without a
// trace, which is exactly the layer range the focus fixup walks. The admitted
// set must name every fixed layout layer on the textarea's ancestor chain
// (and only those — admitting the whole card-shell subtree would let
// streaming message churn flush the 40-entry ledger).

test('the mutation ledger admits every fixed layout layer on the composer ancestor chain', () => {
  for (const layer of [
    'card-shell',
    'card-footer',
    'composer',
    'composer-input-row',
    'pane-tab-panel',
    'pane-content',
    'pane-view',
    'split-child',
    'split-container',
  ]) {
    assert.ok(
      composerChainLayerClasses.includes(layer),
      `layout layer ${layer} must be admitted — it sits on the focus fixup's walk`,
    )
  }
  assert.ok(
    !composerChainLayerClasses.includes('message-list'),
    'message content layers stay out — their churn would flush the ledger',
  )
})

// ── focus method call ledger ────────────────────────────────────────────────
// The kicks above are programmatic: only a blur()/focus() call (or an
// attribute flip) moves focus without a gesture. Recording who CALLS the focus
// methods — with a stack top — names the culprit directly in the next dump.

const methodCall = (atMs: number, kind: 'focus' | 'blur'): FocusMethodCallEntry => ({
  atMs,
  kind,
  path: 'textarea.control.textarea > div.composer',
  landed: kind === 'focus' ? true : undefined,
  stackTop: 'at focusTextarea (ChatCard.tsx:1868)',
})

test('focus method call ledger keeps only the newest entries up to capacity', () => {
  let ledger: FocusMethodCallEntry[] = []
  for (let index = 0; index < focusMethodCallCapacity + 3; index += 1) {
    ledger = pushFocusMethodCallEntry(ledger, methodCall(index, index % 2 === 0 ? 'focus' : 'blur'))
  }
  assert.equal(ledger.length, focusMethodCallCapacity)
  assert.equal(ledger[0]?.atMs, 3)
  assert.equal(ledger.at(-1)?.atMs, focusMethodCallCapacity + 2)
})

test('call stacks are trimmed to a bounded top for the dump', () => {
  const stack = [
    'Error: focus-trace',
    '    at HTMLTextAreaElement.focus (forensics.ts:10)',
    '    at focusTextarea (ChatCard.tsx:1868)',
    '    at runAttempt (composer-focus.ts:137)',
    '    at frame4 (x.ts:4)',
    '    at frame5 (x.ts:5)',
    '    at frame6 (x.ts:6)',
    '    at frame7 (x.ts:7)',
  ].join('\n')
  const trimmed = summarizeCallStack(stack, 4)
  const lines = trimmed.split('\n')
  assert.equal(lines.length, 4, 'the stack must trim to the requested frame count')
  assert.match(trimmed, /focusTextarea/)
  assert.ok(!trimmed.includes('frame7'))
  assert.equal(summarizeCallStack(undefined, 4), '')
})

// ── composer attribute mutation ledger ──────────────────────────────────────
// The other way to kick focus without a gesture is an attribute flip
// (disabled/hidden/inert or a display-changing style) on the composer chain.
// Noise rules: focus-visible class churn tracks every focus transition and
// says nothing; style writes are the textarea height sync unless they touch
// display/visibility.

test('disabled/hidden/inert flips on the composer chain are always recorded', () => {
  assert.equal(
    shouldRecordComposerAttributeMutation({ attributeName: 'disabled', oldValue: null, newValue: '' }),
    true,
  )
  assert.equal(
    shouldRecordComposerAttributeMutation({ attributeName: 'inert', oldValue: '', newValue: null }),
    true,
  )
  assert.equal(
    shouldRecordComposerAttributeMutation({ attributeName: 'hidden', oldValue: null, newValue: '' }),
    true,
  )
})

test('class churn that only toggles focus-visible is noise, real class changes are signal', () => {
  assert.equal(
    shouldRecordComposerAttributeMutation({
      attributeName: 'class',
      oldValue: 'control textarea focus-visible',
      newValue: 'control textarea',
    }),
    false,
  )
  assert.equal(
    shouldRecordComposerAttributeMutation({
      attributeName: 'class',
      oldValue: 'pane-tab-panel is-active',
      newValue: 'pane-tab-panel',
    }),
    true,
  )
})

test('style writes are noise unless they touch display or visibility', () => {
  assert.equal(
    shouldRecordComposerAttributeMutation({
      attributeName: 'style',
      oldValue: 'height: 30px;',
      newValue: 'height: 32px;',
    }),
    false,
  )
  assert.equal(
    shouldRecordComposerAttributeMutation({
      attributeName: 'style',
      oldValue: 'height: 30px;',
      newValue: 'height: 30px; display: none;',
    }),
    true,
  )
})

test('composer attribute mutation ledger keeps only the newest entries up to capacity', () => {
  let ledger: ComposerAttributeMutationEntry[] = []
  for (let index = 0; index < composerAttributeMutationCapacity + 2; index += 1) {
    ledger = pushComposerAttributeMutationEntry(ledger, {
      atMs: index,
      attr: 'class',
      value: 'pane-tab-panel',
      path: 'div.pane-tab-panel',
    })
  }
  assert.equal(ledger.length, composerAttributeMutationCapacity)
  assert.equal(ledger[0]?.atMs, 2)
})

test('the snapshot carries the reactive-kick verdict and the new ledgers', () => {
  const snapshot = assembleForensicsSnapshot({
    reason: 'hotkey',
    nowIso: '2026-07-08T15:00:00.000Z',
    activeElementPath: 'body > html',
    documentHasFocus: true,
    visibilityState: 'visible',
    windowSize: { width: 1400, height: 900 },
    panes: [],
    hitGrid: [],
    pointerLedger: [],
    rafTimestampsMs: [],
    rescueEventTimesMs: [],
    focusLedger: [],
    silentFocusLoss: false,
    reactiveFocusKickCount: 3,
    focusMethodCalls: [methodCall(1_000, 'blur')],
    composerAttrMutations: [
      { atMs: 900, attr: 'disabled', value: '', path: 'textarea.control.textarea' },
    ],
  })
  assert.equal(snapshot.reactiveFocusKickCount, 3)
  assert.equal(snapshot.focusMethodCalls?.[0]?.kind, 'blur')
  assert.equal(snapshot.composerAttrMutations?.[0]?.attr, 'disabled')
})

test('the forensics runtime hooks the focus methods, records focusout destinations, and observes attribute flips', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src', 'diagnostics', 'stuck-pane-forensics.ts'),
    'utf8',
  )
  assert.match(source, /HTMLElement\.prototype\.blur/, 'runtime must hook blur() to name the caller')
  assert.match(source, /HTMLElement\.prototype\.focus/, 'runtime must hook focus() to prove self-heals ran')
  assert.match(source, /relatedTarget/, 'focusout must record where focus went')
  assert.match(source, /MutationObserver/, 'runtime must observe composer attribute flips')
  assert.match(source, /reactiveFocusKickCount/, 'capture must include the reactive-kick verdict')
})

test('focusout forensics records whether React disconnects the focused subtree after dispatch', async () => {
  const source = await readFile(
    path.join(process.cwd(), 'src', 'diagnostics', 'stuck-pane-forensics.ts'),
    'utf8',
  )
  assert.match(source, /connectedAtDispatch/, 'focusout must snapshot connectivity before React removes the node')
  assert.match(source, /queueMicrotask/, 'connectivity must be checked again after the removal commit completes')
  assert.match(source, /connectedAfterMicrotask/, 'the dump must distinguish a live focus target from a deleted one')
  assert.match(source, /detachedRootPath/, 'a deleted focus target must name the detached subtree root')
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

// ── panel unmount probe (2026-07-11 dump: React commitDeletion removed the
// focused `pane-tab-panel.is-active` itself — connectedAfterMicrotask=false,
// detachedRootPath=the panel div — while the reducer has no tab-removal path
// in the streaming window. The probe records, at the exact unmount moment,
// whether the DATA layer still contains the tab: a divergence (render dropped
// it, data kept it) is the React-lane smoking gun; agreement names the action.)

test('pushPanelUnmountEntry keeps the newest entries within capacity', async () => {
  const { pushPanelUnmountEntry, panelUnmountCapacity } = await import(
    '../src/diagnostics/stuck-pane-forensics'
  )
  let ledger: import('../src/diagnostics/stuck-pane-forensics').PanelUnmountEntry[] = []
  for (let index = 0; index < panelUnmountCapacity + 5; index += 1) {
    ledger = pushPanelUnmountEntry(ledger, {
      atMs: index,
      tabId: `tab-${index}`,
      paneId: 'pane-1',
      activeAtUnmount: true,
      dataLayerHasTab: null,
      dataLayerHasCard: null,
    })
  }
  assert.equal(ledger.length, panelUnmountCapacity)
  assert.equal(ledger[0]?.tabId, 'tab-5')
  assert.equal(ledger.at(-1)?.tabId, `tab-${panelUnmountCapacity + 4}`)
})

test('locateTabInAppState reports layout membership and card presence independently', async () => {
  const { locateTabInAppState } = await import('../src/diagnostics/stuck-pane-forensics')
  const state = {
    columns: [
      {
        cards: { 'tab-a': {}, 'tab-orphan-card': {} },
        layout: {
          type: 'split' as const,
          children: [
            { type: 'pane' as const, id: 'p1', tabs: ['tab-a'] },
            { type: 'pane' as const, id: 'p2', tabs: ['tab-layout-only'] },
          ],
        },
      },
    ],
  }
  assert.deepEqual(locateTabInAppState(state, 'tab-a'), {
    tabInLayout: true,
    cardPresent: true,
  })
  // Layout references a tab whose card object vanished — the `if (!card)
  // return null` branch in PaneView would delete the panel for exactly this.
  assert.deepEqual(locateTabInAppState(state, 'tab-layout-only'), {
    tabInLayout: true,
    cardPresent: false,
  })
  assert.deepEqual(locateTabInAppState(state, 'tab-orphan-card'), {
    tabInLayout: false,
    cardPresent: true,
  })
  assert.deepEqual(locateTabInAppState(state, 'tab-gone'), {
    tabInLayout: false,
    cardPresent: false,
  })
})

test('recordPanelUnmountForForensics interrogates the registered data-layer truth', async () => {
  const {
    registerForensicsAppStateTruth,
    recordPanelUnmountForForensics,
    drainPanelUnmountLedgerForTest,
  } = await import('../src/diagnostics/stuck-pane-forensics')
  drainPanelUnmountLedgerForTest()
  registerForensicsAppStateTruth(() => ({
    columns: [
      {
        cards: { 'tab-live': {} },
        layout: { type: 'pane' as const, id: 'p1', tabs: ['tab-live'] },
      },
    ],
  }))
  recordPanelUnmountForForensics({ tabId: 'tab-live', paneId: 'p1', activeAtUnmount: true })
  recordPanelUnmountForForensics({ tabId: 'tab-dead', paneId: 'p1', activeAtUnmount: false })
  const ledger = drainPanelUnmountLedgerForTest()
  assert.equal(ledger.length, 2)
  // Data layer still holds the tab the render just dropped -> lane divergence.
  assert.equal(ledger[0]?.dataLayerHasTab, true)
  assert.equal(ledger[0]?.dataLayerHasCard, true)
  assert.equal(ledger[1]?.dataLayerHasTab, false)
  assert.equal(ledger[1]?.dataLayerHasCard, false)
  registerForensicsAppStateTruth(null)
})

test('applied-action ledger keeps the newest batches within capacity', async () => {
  const { pushAppliedActionsEntry, appliedActionsCapacity } = await import(
    '../src/diagnostics/stuck-pane-forensics'
  )
  let ledger: import('../src/diagnostics/stuck-pane-forensics').AppliedActionsEntry[] = []
  for (let index = 0; index < appliedActionsCapacity + 3; index += 1) {
    ledger = pushAppliedActionsEntry(ledger, { atMs: index, types: ['updateCard'] })
  }
  assert.equal(ledger.length, appliedActionsCapacity)
  assert.equal(ledger[0]?.atMs, 3)
})
