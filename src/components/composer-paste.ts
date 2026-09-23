import { supportedImageMimeTypes as defaultSupportedImageMimeTypes } from './composer-image-paste'

// Pasting files copied from the OS file manager inserts their local absolute
// paths into the composer as text. Path resolution goes through the preload
// `getPathForFile` bridge (Electron 32+ removed `File.path`); in-memory blobs
// such as screenshots resolve to an empty path and are skipped here so they
// keep flowing through the image-attachment paste path.

export function collectPastedFilePaths(
  files: File[],
  getPathForFile: (file: File) => string,
): string[] {
  const paths: string[] = []
  for (const file of files) {
    let path = ''
    try {
      path = getPathForFile(file)
    } catch {
      continue
    }
    if (path.trim().length > 0) {
      paths.push(path)
    }
  }
  return paths
}

export function formatPastedFilePathInsertion(paths: string[]): string {
  return paths.map((path) => (/\s/.test(path) ? `"${path}"` : path)).join(' ')
}

export function insertTextAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after)
  const inserted = `${needsLeadingSpace ? ' ' : ''}${insertion}${needsTrailingSpace ? ' ' : ''}`

  return {
    value: `${before}${inserted}${after}`,
    caret: start + inserted.length,
  }
}

// Dropping files from the OS file manager takes the same two exits as paste:
// supported raster images become image attachments, everything else (including
// SVG and untyped blobs) is a path candidate. The MIME set is injected so this
// stays a pure function for the node test runner.
export function partitionDroppedFiles(
  files: Iterable<File>,
  supportedImageMimeTypes: ReadonlySet<string> = defaultSupportedImageMimeTypes,
): { imageFiles: File[]; pathCandidateFiles: File[] } {
  const imageFiles: File[] = []
  const pathCandidateFiles: File[] = []
  for (const file of files) {
    if (supportedImageMimeTypes.has(file.type)) {
      imageFiles.push(file)
    } else {
      pathCandidateFiles.push(file)
    }
  }
  return { imageFiles, pathCandidateFiles }
}
