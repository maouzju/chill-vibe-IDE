import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolvePaneTabCloseTargets } from '../src/components/pane-tab-close-targets.ts'

describe('resolvePaneTabCloseTargets — tab 右键菜单的批量关闭目标', () => {
  it('splits the pane tabs around the clicked tab', () => {
    assert.deepEqual(resolvePaneTabCloseTargets(['a', 'b', 'c', 'd'], 'c'), {
      others: ['a', 'b', 'd'],
      toTheLeft: ['a', 'b'],
      toTheRight: ['d'],
    })
  })

  it('has nothing to close on the left for the first tab', () => {
    assert.deepEqual(resolvePaneTabCloseTargets(['a', 'b'], 'a'), {
      others: ['b'],
      toTheLeft: [],
      toTheRight: ['b'],
    })
  })

  it('has nothing to close on the right for the last tab', () => {
    assert.deepEqual(resolvePaneTabCloseTargets(['a', 'b'], 'b'), {
      others: ['a'],
      toTheLeft: ['a'],
      toTheRight: [],
    })
  })

  it('returns empty targets for a single tab pane', () => {
    assert.deepEqual(resolvePaneTabCloseTargets(['a'], 'a'), {
      others: [],
      toTheLeft: [],
      toTheRight: [],
    })
  })

  // 症状：右键一个已经不在该 pane 里的 tab 会把整条 tab 栏关光。
  // 根因：indexOf 返回 -1 时 slice(0, -1 + 1) === slice(0, 0) 看着安全，但
  // slice(-1 + 1) === slice(0) 是「全部」，旧的 closeRight 正是这么算的。
  it('closes nothing when the tab is not in the pane', () => {
    assert.deepEqual(resolvePaneTabCloseTargets(['a', 'b'], 'ghost'), {
      others: [],
      toTheLeft: [],
      toTheRight: [],
    })
  })
})
