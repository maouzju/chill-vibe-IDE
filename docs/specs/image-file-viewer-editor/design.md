# Design — Image File Viewer & Lightweight Editor

## Approach
Reuse the existing tool-card pattern instead of adding a new top-level app surface.

1. Add an image tool model constant.
2. Add lightweight image card state on `ChatCard` for the currently opened image path.
3. Route file opens through a helper:
   - image extension → image viewer card
   - everything else → existing text editor card
4. Read image bytes through the existing file read bridge. Binary reads already return text content using a byte-preserving binary string for small files, which can be converted to base64 in the renderer.
5. Render image editing with browser-native canvas APIs. No new heavy dependency.

## Card UI
- Header strip: relative path and file stats.
- Toolbar: Fit, 100%, zoom -, zoom +, rotate, flip, reset, export PNG.
- Adjustment panel: brightness, contrast, saturation sliders; crop inset numeric controls.
- Canvas/preview stage: centered image, checker/neutral background, scroll/overflow as needed.

## Data model
`ChatCard.imageViewer` stores:
- `relativePath`
- optional `revision`
- optional `size`

No edited pixels are persisted into app state; edits are ephemeral in component state.

## Safety
- Do not overwrite original image in this slice.
- Respect workspace path validation through existing read API.
- Avoid large binary crashes by using the same server limits as file read.
