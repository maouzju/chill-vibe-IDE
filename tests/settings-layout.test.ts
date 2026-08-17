import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createInterfaceDefaultsPatch,
  getStableSettingsPanelColumnCount,
  splitSettingsGroupsIntoStableColumns,
  stableSettingsPanelColumnThresholdPx,
} from '../src/settings-layout.ts'
import { createDefaultEditorSettings } from '../shared/default-state.ts'

describe('settings layout', () => {
  it('keeps a single column until the panel can fit two full-width groups', () => {
    assert.equal(getStableSettingsPanelColumnCount(stableSettingsPanelColumnThresholdPx - 1), 1)
    assert.equal(getStableSettingsPanelColumnCount(stableSettingsPanelColumnThresholdPx), 2)
  })

  it('preserves the original order when only one column is available', () => {
    const groups = ['update', 'appearance', 'models', 'utility']

    assert.deepEqual(splitSettingsGroupsIntoStableColumns(groups, 1), [groups])
  })

  it('pins groups to deterministic columns even when their heights later change', () => {
    const groups = [
      { id: 'update', height: 120 },
      { id: 'appearance', height: 260 },
      { id: 'models', height: 220 },
      { id: 'utility', height: 280 },
      { id: 'experimental', height: 240 },
      { id: 'environment', height: 380 },
      { id: 'data', height: 140 },
    ]

    const initialColumns = splitSettingsGroupsIntoStableColumns(groups, 2).map((column) =>
      column.map((group) => group.id),
    )
    const expandedColumns = splitSettingsGroupsIntoStableColumns(
      groups.map((group) =>
        group.id === 'utility' || group.id === 'experimental'
          ? { ...group, height: group.height + 220 }
          : group,
      ),
      2,
    ).map((column) => column.map((group) => group.id))

    assert.deepEqual(initialColumns, [
      ['update', 'models', 'experimental', 'data'],
      ['appearance', 'utility', 'environment'],
    ])
    assert.deepEqual(expandedColumns, initialColumns)
  })

  it('resets the editor sub-module together with the rest of the appearance group', () => {
    const patch = createInterfaceDefaultsPatch()

    assert.deepEqual(patch.editor, createDefaultEditorSettings())
    assert.equal(patch.uiScale, 1)
    assert.equal(patch.fontFamily, 'default')
    assert.equal(patch.fontScale, 1)
    assert.equal(patch.lineHeightScale, 1)
    assert.equal(patch.theme, 'light')
    assert.equal(patch.customThemeBase, 'dark')
    assert.equal(patch.customBaseColor, null)
    assert.equal(patch.accentColor, null)
  })
})
