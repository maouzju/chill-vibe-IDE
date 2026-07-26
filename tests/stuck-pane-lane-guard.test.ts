import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// ── Guard for stuck-pane root cause #10 (2026-07-11) ────────────────────────
// The fix for this root cause is an *absence* of code, so no behavioural test
// in the suite can protect it: `src/App.tsx` simply must not wrap its
// `ideReducer` commits in `startTransition`. Anyone re-adding that wrapper
// gets a fully green suite today, and the long-standing "用久了整个页面卡死"
// bug comes back. These assertions are the only thing standing in the way.
const appSourceUrl = new URL('../src/App.tsx', import.meta.url)

const WHY_THIS_TEST_EXISTS = [
  '',
  '--- WHY THIS TEST EXISTS (do NOT "fix" the test) ---',
  'This guards root cause #10 of the long-standing "the whole page freezes after a while"',
  'bug (AGENTS.md pitfall 194; earlier related incident: pitfall 181).',
  '',
  'Wrapping an ideReducer commit in startTransition splits app state across two React lanes.',
  'The transition render can be interrupted and starved for seconds by urgent updates under',
  'load, while the interleaved urgent commit renders from a rebased intermediate state. The',
  '2026-07-11 forensics dump caught the consequence: React ran commitDeletion on the currently',
  'focused `.pane-tab-panel.is-active` subtree and rebuilt it — 8 delete/remount oscillations in',
  '3 seconds, focus repeatedly dropped to <body>, the page effectively frozen — even though the',
  'data layer never dispatched any tab-removing action.',
  '',
  'Every commit that goes through `ideReducer` must stay in the single urgent React lane.',
  'Delta/activity flushes are already throttled, and an urgent commit is cheap. Component-local',
  'setState transitions (GitToolCard, GitFullDialog) are NOT affected by this rule.',
  '--------------------------------------------------',
].join('\n')

/**
 * Strips comments so the assertions target real calls, not prose. The rule is
 * deliberately about `startTransition(` as a *call site*: an ADR comment that
 * explains why startTransition is banned must never turn this guard red.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')))
    .join('\n')
}

/**
 * Extracts one top-level `const <name> = useCallback(...)` block from App.tsx.
 * The file is prettier-formatted, so the callback always terminates on the
 * first following line that starts with exactly two spaces then `)` or `}`.
 */
function extractCallbackBlock(source: string, name: string): string {
  const lines = source.split('\n')
  const declPattern = new RegExp(`^ {2}const ${name} = useCallback\\(`)
  const startIndex = lines.findIndex((line) => declPattern.test(line))
  assert.ok(
    startIndex >= 0,
    `Cannot find "const ${name} = useCallback(" in src/App.tsx. This guard can no longer see the reducer commit path it is supposed to protect — re-point it at the renamed function instead of deleting it.${WHY_THIS_TEST_EXISTS}`,
  )

  let endIndex = -1
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^ {2}[)}]/.test(lines[index])) {
      endIndex = index
      break
    }
  }
  assert.ok(
    endIndex > startIndex,
    `Could not find the end of ${name} in src/App.tsx; the guard would be checking the wrong text.`,
  )
  assert.ok(
    endIndex - startIndex < 150,
    `Extracted an implausibly large block for ${name} in src/App.tsx (${endIndex - startIndex} lines); the guard is probably mis-parsing the file.`,
  )

  return stripComments(lines.slice(startIndex, endIndex + 1).join('\n'))
}

const TRANSITION_CALL = /\b(?:React\s*\.\s*)?(?:startTransition|useTransition)\s*\(/

test('applyActions — the single ideReducer dispatch funnel — stays in the urgent lane', async () => {
  const source = await readFile(appSourceUrl, 'utf8')
  const block = extractCallbackBlock(source, 'applyActions')

  assert.match(
    block,
    /\bdispatch\(action\)/,
    'applyActions must still be the single funnel that dispatches ideReducer actions; if this moved, re-point the lane guard at the new funnel.',
  )
  assert.doesNotMatch(
    block,
    TRANSITION_CALL,
    `applyActions() dispatches every ideReducer action — wrapping that dispatch in a transition puts ALL app state into a non-urgent lane.${WHY_THIS_TEST_EXISTS}`,
  )
})

for (const target of [
  {
    name: 'flushStreamRenderBuffers',
    what: 'the streaming delta/activity flush',
  },
  {
    name: 'flushBufferedActivitiesForCard',
    what: 'the buffered activity flush for a single card',
  },
  {
    name: 'appendCardLogs',
    what: 'the card log append path',
  },
]) {
  test(`${target.name} commits reducer actions in the urgent lane`, async () => {
    const source = await readFile(appSourceUrl, 'utf8')
    const block = extractCallbackBlock(source, target.name)

    assert.doesNotMatch(
      block,
      TRANSITION_CALL,
      `${target.name} (${target.what}) must commit its reducer actions urgently, not inside a transition.${WHY_THIS_TEST_EXISTS}`,
    )
  })
}

test('no transition callback anywhere in App.tsx encloses a reducer commit', async () => {
  const raw = await readFile(appSourceUrl, 'utf8')
  const source = stripComments(raw)

  assert.doesNotMatch(
    source,
    /\buseTransition\s*\(/,
    `src/App.tsx must not call useTransition(). The start function it returns can be bound to any local name, which would silently defeat every textual guard in this file. If a genuinely lane-safe transition is ever needed in App.tsx, teach this guard about it deliberately.${WHY_THIS_TEST_EXISTS}`,
  )

  const reducerCommit = /\b(?:applyActions?|dispatch|persistAfterActions?|persistImmediately)\s*\(/
  const offenders: string[] = []
  for (const match of source.matchAll(/\bstartTransition\s*\(/g)) {
    const start = match.index ?? 0
    if (!reducerCommit.test(source.slice(start, start + 400))) {
      continue
    }
    const line = source.slice(0, start).split('\n').length
    offenders.push(`src/App.tsx:${line}`)
  }

  assert.deepEqual(
    offenders,
    [],
    `A startTransition() callback in App.tsx contains an ideReducer commit at: ${offenders.join(', ')}.${WHY_THIS_TEST_EXISTS}`,
  )
})

test('the urgent-lane rationale stays recorded at the code site', async () => {
  const source = await readFile(appSourceUrl, 'utf8')

  assert.match(
    source,
    /one urgent[\s\S]{0,40}React lane/,
    'flushStreamRenderBuffers must keep its "keep one urgent React lane" comment; the next reader has to know the single-lane rule is deliberate, not an oversight.',
  )
  assert.match(
    source,
    /reducer updates must stay in[\s\S]{0,40}one React lane/,
    'appendCardLogs must keep its "Urgent on purpose" comment explaining the single-lane rule.',
  )
  assert.match(
    source,
    /2026-07-11 panel delete\/remount oscillation/,
    'Keep the 2026-07-11 panel delete/remount oscillation reference in App.tsx — it is the evidence anchor for stuck-pane root cause #10.',
  )
})
