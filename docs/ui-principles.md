# UI Principles

This document is the visual contract for Chill Vibe's frontend.

It exists to reduce subjective back-and-forth. If a UI change violates these rules, it should be revised before asking for product feedback.

## Product Tone

- Quiet over clever: the board should feel calm, not decorated.
- Content first: chats and workspace context carry the visual weight, not the chrome around them.
- Subtractive by default: if a line, pill, border, glow, or shadow does not help orientation or action, remove it.
- Stable across themes: light and dark may differ in color, but not in hierarchy or spacing logic.

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

### 4. Visual Hierarchy Must Be Obvious

- Page/frame chrome is quieter than column chrome.
- Column chrome is quieter than card chrome.
- Card chrome is quieter than message content and input focus.
- A user should be able to tell what is interactive, what is selected, and what is merely structural without reading labels.

### 5. State Changes Must Be Intentional

- Hover should clarify affordance, not redraw the whole screen.
- Focus must be accessible and visible in both themes.
- Selected state should be stronger than hover.
- Drag/drop state should be obvious but temporary.
- Disabled state should reduce affordance without destroying legibility.

### 6. Tokens Before Tweaks

- Use shared tokens in [`src/index.css`](../src/index.css) for spacing, seams, surfaces, and emphasis.
- Do not fix a local layout problem with one-off padding unless the component truly owns that spacing.
- When a visual rule repeats twice, promote it into a token or a documented invariant.

## Anti-Patterns

- Decorative lines that remain visible while idle.
- Solving alignment bugs with per-theme pixel nudges unless the root cause is theme-specific.
- Multiple nested borders trying to describe the same container.
- Controls that are louder than the work content.
- Mobile layouts that introduce extra seams or offsets not present on desktop.
- Asking for pixel feedback before checking the documented invariants.

## Review Checklist

Before asking for design feedback on any frontend change:

- Check desktop and narrow viewport.
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

If a future redesign intentionally changes one of these invariants, update this document and the tests in the same change.
