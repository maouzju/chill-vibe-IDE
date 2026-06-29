import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const projectRoot = process.cwd()

test('critical chat controls activate on mouse down instead of waiting for click', async () => {
  const source = await readFile(path.join(projectRoot, 'src', 'components', 'ChatCard.tsx'), 'utf8')

  assert.match(
    source,
    /const revealAllCompactedHistoryPressHandlers = usePrimaryMouseDownActivation/,
    'the compacted-history reveal button should fire on mouse down so re-rendered transcripts do not eat the click',
  )
  assert.match(
    source,
    /className="btn btn-ghost"[\s\S]*\{\.\.\.revealAllCompactedHistoryPressHandlers\}/,
    'the compacted-history reveal button should use the mouse-down activation handlers',
  )
  assert.match(
    source,
    /const stopRunPressHandlers = usePrimaryMouseDownActivation/,
    'the stop-run button should fire on mouse down so streaming re-renders do not eat the click',
  )
  assert.match(
    source,
    /label=\{text\.stopRun\}[\s\S]*\{\.\.\.stopRunPressHandlers\}/,
    'the stop-run button should use the mouse-down activation handlers',
  )
})

test('session history menu controls activate on mouse down instead of waiting for click', async () => {
  const source = await readFile(path.join(projectRoot, 'src', 'components', 'WorkspaceColumn.tsx'), 'utf8')

  assert.match(
    source,
    /const historyMenuTogglePressHandlers = usePrimaryMouseDownActivation/,
    'the session-history entry point should open on mouse down',
  )
  assert.match(
    source,
    /label=\{text\.sessionHistory\}[\s\S]*\{\.\.\.historyMenuTogglePressHandlers\}/,
    'the session-history header button should use the mouse-down activation handlers',
  )
  assert.match(
    source,
    /const handleRestoreSessionHistoryPress = useCallback/,
    'internal history rows should share a mouse-down restore handler',
  )
  assert.match(
    source,
    /className=\{`session-history-item is-\$\{getSessionHistoryLifecycle\(entry\)\}`\}[\s\S]*onMouseDown=\{\(event\) => handleRestoreSessionHistoryPress\(event, entry\.id\)\}/,
    'internal history rows should restore on mouse down before the menu can be re-rendered away',
  )
  assert.match(
    source,
    /const handleImportExternalSessionPress = useCallback/,
    'external history rows should share a mouse-down import handler',
  )
  assert.match(
    source,
    /className="session-history-item"[\s\S]*onMouseDown=\{\(event\) => handleImportExternalSessionPress\(event, session\)\}/,
    'external history rows should import on mouse down before the menu can be re-rendered away',
  )
})
