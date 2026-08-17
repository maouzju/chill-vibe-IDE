# UI Principles

This document is the visual contract for Chill Vibe's frontend.

It exists to reduce subjective back-and-forth. If a UI change violates these rules, it should be revised before asking for product feedback.

## Product Tone

- Quiet over clever: the board should feel calm, not decorated.
- Content first: chats and workspace context carry the visual weight, not the chrome around them.
- Subtractive by default: if a line, pill, border, glow, or shadow does not help orientation or action, remove it.
- Stable across themes: light and dark may differ in color, but not in hierarchy or spacing logic.
- Empty setup states should feel like a small guided next step: one clear primary action, quiet context, and no generic error-card chrome.

## Hard Rules

### 1. One Seam, One Reason

- Adjacent surfaces should usually be separated by exactly one visual seam.
- Do not stack `gap + border + shadow + handle` to express the same boundary.
- Board seams must come from shared tokens, not one-off component padding hacks.

### 2. Shared Alignment Grid

- Column header content and column body content must start on the same left edge.
- Column header content and column body content must end on the same right edge.
- If cards are flush to a column edge, header controls and titles must respect the same grid.
- Narrow screens must preserve the same alignment logic after reflow.

### 3. Idle Chrome Must Recede

- Drag handles, resize guides, and helper rails should be invisible at rest.
- Interaction affordances may appear on hover, focus, drag, or resize, but should not linger as decoration.
- Persistent utility chrome is a bug unless it carries primary meaning.
- Explanatory copy is idle chrome too. In dense control surfaces (the composer settings menu, the
  Settings panel, tool popovers), "what does this switch do" belongs behind hover — every control
  carries one, and none of them is printed inline. Live state (a warning, a count, a version, an
  install status) is not an explanation and may stay visible. So may the one-line intro that
  introduces a whole group. See [`ComposerSettingsRow`](../src/components/ComposerSettingsRow.tsx),
  the `.settings-hover-detail` / `.settings-hover-note` pair in [`src/index.css`](../src/index.css),
  [`tests/composer-settings-hints.spec.ts`](../tests/composer-settings-hints.spec.ts) and
  [`tests/settings-hover-hints.spec.ts`](../tests/settings-hover-hints.spec.ts).

### 4. Visual Hierarchy Must Be Obvious

- Page/frame chrome is quieter than column chrome.
- Column chrome is quieter than card chrome.
- Card chrome is quieter than message content and input focus.
- A user should be able to tell what is interactive, what is selected, and what is merely structural without reading labels.

### 5. State Changes Must Be Intentional

- Hover should clarify affordance, not redraw the whole screen.
- Focus must be accessible and visible in both themes.
- After sending a chat, the composer should clear and keep focus so follow-up typing stays immediate unless the flow explicitly hands focus elsewhere.
- Image attachments should stay compact inline, but both message and composer thumbnails must open a larger preview for inspection.
- Selected state should be stronger than hover.
- Drag/drop state should be obvious but temporary.
- Disabled state should reduce affordance without destroying legibility.

### 6. Card Surfaces Reflow On Their Own Width, Not The Viewport's

- Anything rendered inside a workspace column or a split pane must use **container queries**
  (`container-type: inline-size` + `@container`), not `@media (max-width: …)`.
- A column can be dragged down to `130px` while the window stays at `2560px`. A viewport breakpoint
  measures the wrong box and, in practice, never fires — the surface just gets silently squeezed.
- Query the box that actually owns the constraint. When a card holds sub-columns (lanes, grids),
  make those sub-columns containers too: a lane in a wide 3-up board can be narrower than the same
  lane in a stacked narrow board, so one breakpoint cannot describe both.
- Reflow instead of shrink: below the width where a row's content still reads, drop to fewer
  columns. Never keep N columns and let the labels truncate to two characters.

### 7. Tokens Before Tweaks

- Use shared tokens in [`src/index.css`](../src/index.css) for spacing, seams, surfaces, and emphasis.
- Do not fix a local layout problem with one-off padding unless the component truly owns that spacing.
- When a visual rule repeats twice, promote it into a token or a documented invariant.

## Anti-Patterns

- Decorative lines that remain visible while idle.
- Solving alignment bugs with per-theme pixel nudges unless the root cause is theme-specific.
- Multiple nested borders trying to describe the same container.
- Controls that are louder than the work content.
- Mobile layouts that introduce extra seams or offsets not present on desktop.
- `@media (max-width: …)` used to make a card, pane, or column-hosted surface responsive.
- Asking for pixel feedback before checking the documented invariants.

## Review Checklist

Before asking for design feedback on any frontend change:

- Check desktop and narrow viewport, **and** a narrow column inside a wide window (they are not the
  same test — see rule 6).
- Check both `light` and `dark`.
- Check default, hover, focus, selected, drag/drop, empty, and disabled states where relevant.
- Confirm seams are token-driven and not duplicated.
- Confirm header/body alignment for any modified column or card container.
- Confirm idle resize/drag affordances are hidden unless actively needed.
- Run the visual regression tests that guard these invariants.

## Current High-Value Invariants

These are important enough to automate:

- Board column seams stay minimal and consistent across themes.
- Column header and body content align on the same grid.
- Resize affordances do not remain visible while idle.
- Every row of the composer settings menu documents itself through a hover hint, and no hint is
  rendered inline — pinned by [`tests/composer-settings-hints.spec.ts`](../tests/composer-settings-hints.spec.ts).
- Settings panel toggles document themselves the same way: each one points at its hint through
  `aria-describedby`, and the hint sits in a `.settings-hover-note` that is hidden at rest — pinned
  by [`tests/settings-hover-hints.spec.ts`](../tests/settings-hover-hints.spec.ts).
- Column-hosted surfaces reflow on their own inline-size: the automation board's lane grid is pinned
  at 3 / 2 / 1 tracks by [`tests/automation-board-layout.spec.ts`](../tests/automation-board-layout.spec.ts),
  which holds the viewport at 1440px and only changes how many columns are open.

If a future redesign intentionally changes one of these invariants, update this document and the tests in the same change.
