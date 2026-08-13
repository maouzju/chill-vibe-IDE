import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resizeColumnGroups } from '../src/column-resize.ts'
import {
  AUTOMATION_BOARD_LANE_MIN_WIDTH,
  getAutomationBoardLaneTracks,
  resolveAutomationBoardLaneWidths,
  toAutomationBoardLaneWidths,
} from '../src/components/automation-board-lane-resize.ts'

describe('automation board lane resize', () => {
  it('falls back to an even split when no width was ever saved', () => {
    assert.deepEqual(resolveAutomationBoardLaneWidths(undefined), [1, 1, 1])
  })

  it('reads the saved widths in lane order', () => {
    assert.deepEqual(
      resolveAutomationBoardLaneWidths({ standby: 500, running: 350, done: 350 }),
      [500, 350, 350],
    )
  })

  it('retreats to an even split when any saved width is unusable', () => {
    // 局部修补（只把坏的那条改成 1）会让另外两条的比例凭空放大几百倍，
    // 用户看到的是一条几乎不可见的泳道 —— 整组回默认才是可预期的。
    for (const broken of [
      { standby: 0, running: 1, done: 1 },
      { standby: -3, running: 1, done: 1 },
      { standby: Number.NaN, running: 1, done: 1 },
      { standby: Number.POSITIVE_INFINITY, running: 1, done: 1 },
      { standby: 1, running: 1, done: 0 },
    ]) {
      assert.deepEqual(
        resolveAutomationBoardLaneWidths(broken as never),
        [1, 1, 1],
        `expected an even split for ${JSON.stringify(broken)}`,
      )
    }
  })

  it('turns widths into grid tracks that can never overflow their content', () => {
    // minmax(0, …) 是硬要求：没有它，一条泳道里的长需求标题会把轨道顶宽，
    // 用户拖出来的比例当场作废。
    assert.equal(
      getAutomationBoardLaneTracks([500, 350, 350]),
      'minmax(0, 500fr) minmax(0, 350fr) minmax(0, 350fr)',
    )
  })

  it('names the widths by lane when handing them to the reducer', () => {
    assert.deepEqual(toAutomationBoardLaneWidths([500, 350, 350]), {
      standby: 500,
      running: 350,
      done: 350,
    })
  })

  it('drags the first divider by moving the two right lanes together', () => {
    const dragged = resizeColumnGroups(
      [400, 400, 400],
      0,
      100,
      AUTOMATION_BOARD_LANE_MIN_WIDTH,
    )

    assert.deepEqual(dragged, [500, 350, 350])
  })

  it('stops shrinking a lane at the readable minimum instead of collapsing it', () => {
    const dragged = resizeColumnGroups(
      [400, 400, 400],
      1,
      10_000,
      AUTOMATION_BOARD_LANE_MIN_WIDTH,
    )

    assert.equal(dragged[2], AUTOMATION_BOARD_LANE_MIN_WIDTH)
    assert.equal(
      dragged.reduce((sum, width) => sum + width, 0),
      1200,
      'the board is not allowed to grow or shrink while a divider moves',
    )
  })

  it('survives a save/load round trip without drifting', () => {
    const dragged = resizeColumnGroups([400, 400, 400], 0, 100, AUTOMATION_BOARD_LANE_MIN_WIDTH)
    const saved = toAutomationBoardLaneWidths(dragged)

    assert.deepEqual(resolveAutomationBoardLaneWidths(saved), dragged)
  })
})
