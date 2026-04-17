import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  autoScrollBottomThresholdPx,
  didUserInterruptProgrammaticScroll,
  getAutoScrollStateAfterCardUpdate,
  getAutoScrollStateAfterUserScroll,
  getCompactedHistoryAutoRevealMode,
  getRestoredMessageListScrollPlan,
  getScrollTopToRevealChild,
  getScrollTopToRevealChildWithTopClearance,
  getProgrammaticBottomScrollTarget,
  shouldAutoRevealCompactedHistoryImmediately,
  shouldPinToBottomAfterContentGrowth,
} from '../src/components/chat-scroll.ts'

describe('chat scroll helpers', () => {
  it('tracks the real bottom position when auto-scroll snaps the message list', () => {
    const target = getProgrammaticBottomScrollTarget({
      scrollHeight: 1080,
      clientHeight: 420,
    })

    assert.equal(target, 660)
  })

  it('disables auto-scroll when the first user scroll-up starts from the synced bottom edge', () => {
    const bottomScrollTop = getProgrammaticBottomScrollTarget({
      scrollHeight: 1080,
      clientHeight: 420,
    })

    const next = getAutoScrollStateAfterUserScroll(bottomScrollTop, {
      scrollTop: bottomScrollTop - 10,
      scrollHeight: 1080,
      clientHeight: 420,
    })

    assert.equal(next.lastScrollTop, bottomScrollTop - 10)
    assert.equal(next.shouldAutoScroll, false)
  })

  it('shows why a stale previous scroll position near the bottom used to keep auto-scroll armed', () => {
    const next = getAutoScrollStateAfterUserScroll(0, {
      scrollTop: 650,
      scrollHeight: 1080,
      clientHeight: 420,
    })

    assert.equal(1080 - 420 - 650, 10)
    assert.equal(10 < autoScrollBottomThresholdPx, true)
    assert.equal(next.lastScrollTop, 650)
    assert.equal(next.shouldAutoScroll, true)
  })

  it('keeps auto-scroll armed when layout shrink clamps the list to a new bottom', () => {
    const next = getAutoScrollStateAfterUserScroll(660, {
      scrollTop: 580,
      scrollHeight: 1000,
      clientHeight: 420,
    })

    assert.equal(next.lastScrollTop, 580)
    assert.equal(next.shouldAutoScroll, true)
  })

  it('preserves a disabled auto-scroll preference when the same card starts streaming', () => {
    const next = getAutoScrollStateAfterCardUpdate({
      previousCardId: 'card-1',
      currentCardId: 'card-1',
      previousShouldAutoScroll: false,
      shouldStartPinnedToBottom: true,
      isRestoredAnchorLocked: false,
    })

    assert.equal(next, false)
  })

  it('re-arms auto-scroll when switching to a different streaming card', () => {
    const next = getAutoScrollStateAfterCardUpdate({
      previousCardId: 'card-1',
      currentCardId: 'card-2',
      previousShouldAutoScroll: false,
      shouldStartPinnedToBottom: true,
      isRestoredAnchorLocked: false,
    })

    assert.equal(next, true)
  })

  it('does not treat an in-flight programmatic scroll toward the bottom as a user escape', () => {
    assert.equal(
      didUserInterruptProgrammaticScroll(
        {
          startScrollTop: 340,
          targetScrollTop: 660,
        },
        480,
      ),
      false,
    )
  })

  it('still lets an explicit user scroll in the opposite direction break auto-scroll during a guard window', () => {
    assert.equal(
      didUserInterruptProgrammaticScroll(
        {
          startScrollTop: 340,
          targetScrollTop: 660,
        },
        300,
      ),
      true,
    )
  })

  it('keeps the current scroll position when the child is already visible inside the menu viewport', () => {
    const next = getScrollTopToRevealChild(
      {
        scrollTop: 120,
        clientHeight: 240,
      },
      {
        offsetTop: 180,
        offsetHeight: 40,
      },
    )

    assert.equal(next, 120)
  })

  it('scrolls upward only enough to reveal a child above the current menu viewport', () => {
    const next = getScrollTopToRevealChild(
      {
        scrollTop: 180,
        clientHeight: 220,
      },
      {
        offsetTop: 120,
        offsetHeight: 36,
      },
    )

    assert.equal(next, 120)
  })

  it('scrolls downward only enough to reveal a child below the current menu viewport', () => {
    const next = getScrollTopToRevealChild(
      {
        scrollTop: 40,
        clientHeight: 180,
      },
      {
        offsetTop: 190,
        offsetHeight: 48,
      },
    )

    assert.equal(next, 58)
  })

  it('reveals a child above the viewport while preserving sticky-preview clearance', () => {
    const next = getScrollTopToRevealChildWithTopClearance(
      {
        scrollTop: 320,
        clientHeight: 320,
      },
      {
        offsetTop: 290,
        offsetHeight: 48,
      },
      84,
    )

    assert.equal(next, 206)
  })

  it('does not move when the child is already visible below the sticky-preview clearance', () => {
    const next = getScrollTopToRevealChildWithTopClearance(
      {
        scrollTop: 240,
        clientHeight: 320,
      },
      {
        offsetTop: 340,
        offsetHeight: 56,
      },
      72,
    )

    assert.equal(next, 240)
  })

  it('clamps sticky-preview reveal scroll positions at the top of the list', () => {
    const next = getScrollTopToRevealChildWithTopClearance(
      {
        scrollTop: 120,
        clientHeight: 300,
      },
      {
        offsetTop: 36,
        offsetHeight: 40,
      },
      96,
    )

    assert.equal(next, 0)
  })

  it('marks compacted history as auto-revealable when the list has no scrollbar yet', () => {
    const mode = getCompactedHistoryAutoRevealMode({
      scrollTop: 0,
      scrollHeight: 320,
      clientHeight: 320,
    })

    assert.equal(mode, 'unscrollable')
  })

  it('auto-reveals compacted history immediately when the list is already near the top', () => {
    const mode = getCompactedHistoryAutoRevealMode({
      scrollTop: 40,
      scrollHeight: 1280,
      clientHeight: 640,
    })

    assert.equal(mode, 'near-top')
    assert.equal(shouldAutoRevealCompactedHistoryImmediately(mode), true)
  })

  it('prefers the previous user prompt anchor when the latest reply is still close to the bottom', () => {
    assert.deepEqual(
      getRestoredMessageListScrollPlan({
        scrollHeight: 1880,
        clientHeight: 520,
        anchorScrollTop: 980,
      }),
      {
        mode: 'anchor',
        scrollTop: 980,
        bottomSpacerPx: 0,
      },
    )
  })

  it('falls back to the latest message when the restored anchor would jump too far away from the bottom', () => {
    assert.deepEqual(
      getRestoredMessageListScrollPlan({
        scrollHeight: 3600,
        clientHeight: 520,
        anchorScrollTop: 760,
      }),
      {
        mode: 'bottom',
        scrollTop: 3080,
        bottomSpacerPx: 0,
      },
    )
  })

  it('adds temporary bottom space when the last reply is too short to push the final user prompt into sticky mode by itself', () => {
    assert.deepEqual(
      getRestoredMessageListScrollPlan({
        scrollHeight: 828,
        clientHeight: 561,
        anchorScrollTop: 794,
      }),
      {
        mode: 'anchor',
        scrollTop: 794,
        bottomSpacerPx: 527,
      },
    )
  })

  it('re-pins to the new bottom when async content growth happens while the user was pinned and idle', () => {
    // Scenario: stream finished, scrollTop was at the previous bottom (580).
    // Afterwards an async block (image / code highlight / mermaid) expands the
    // list from scrollHeight=1000 to 1100. scrollTop stays at 580 because the
    // browser did not move it, but the real bottom is now 680. Since the user
    // did not scroll, auto-scroll must still want to follow.
    assert.equal(
      shouldPinToBottomAfterContentGrowth({
        previousBottomScrollTop: 580,
        currentMetrics: {
          scrollTop: 580,
          scrollHeight: 1100,
          clientHeight: 420,
        },
        wasPinned: true,
      }),
      true,
    )
  })

  it('does not re-pin after content growth if the user had already scrolled up before the growth', () => {
    assert.equal(
      shouldPinToBottomAfterContentGrowth({
        previousBottomScrollTop: 580,
        currentMetrics: {
          scrollTop: 200,
          scrollHeight: 1100,
          clientHeight: 420,
        },
        wasPinned: false,
      }),
      false,
    )
  })

  it('does not re-pin when there was no actual content growth', () => {
    assert.equal(
      shouldPinToBottomAfterContentGrowth({
        previousBottomScrollTop: 580,
        currentMetrics: {
          scrollTop: 580,
          scrollHeight: 1000,
          clientHeight: 420,
        },
        wasPinned: true,
      }),
      false,
    )
  })

  it('tolerates sub-pixel drift between previousBottomScrollTop and the old bottom position', () => {
    // The user was effectively pinned (within 1px of the bottom) when growth
    // started; we should still follow the new bottom.
    assert.equal(
      shouldPinToBottomAfterContentGrowth({
        previousBottomScrollTop: 579.4,
        currentMetrics: {
          scrollTop: 579.4,
          scrollHeight: 1100,
          clientHeight: 420,
        },
        wasPinned: true,
      }),
      true,
    )
  })
})
