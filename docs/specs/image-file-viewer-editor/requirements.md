# Requirements — Image File Viewer & Lightweight Editor

## Goal
When the user clicks an image in the Files card, Chill Vibe should open it inside a card instead of treating it like a text file. The card should also provide lightweight Photoshop-like editing for quick annotations and adjustments.

## Scope
- Detect common workspace image files: PNG, JPEG/JPG, WEBP, GIF, SVG.
- Open image files from the Files card into the existing card area.
- Show a large, card-local image preview with filename, size metadata when available, zoom controls, fit-to-card, and reset.
- Provide lightweight editing tools that are safe and fast:
  - rotate left/right
  - flip horizontal/vertical
  - crop by numeric/slider-like controls
  - basic brightness/contrast/saturation adjustment
  - export/download edited PNG from the card
- Keep original file untouched unless a future explicit “save back” flow is designed.

## Non-goals
- Full Photoshop parity, layers, masks, text effects, or destructive overwrite.
- Editing animated GIF frames; GIF can be previewed, while editing/export may be disabled or rasterize first frame later.
- External cloud image APIs.

## UX Requirements
- Image preview must live inside a Chill Vibe card.
- The Files card click should route images to the image viewer/editor and text files to the existing text editor.
- UI should stay quiet and theme-safe in light and dark themes.
- If image loading fails, show a readable card-local error and keep the user on the board.

## Verification
- Add focused tests for image path detection / routing helpers.
- Run TypeScript/ESLint quality check.
- For theme-sensitive UI, run theme checks when the current Playwright harness is usable; if blocked by known runner issue, document fallback verification.
