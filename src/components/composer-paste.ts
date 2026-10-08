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

const decodeClipboardHtmlText = (value: string): string => value
  .replaceAll('&nbsp;', ' ')
  .replaceAll('&quot;', '"')
  .replaceAll('&#34;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&')
  .replace(/&#(x[0-9a-f]+|[0-9]+);/giu, (_match, code: string) => {
    const parsed = code.toLowerCase().startsWith('x')
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10)
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff
      ? String.fromCodePoint(parsed)
      : ''
  })

/**
 * 从剪贴板生成聊天输入框应插入的纯文本。
 *
 * 飞书表格大多数时候会同时提供 text/plain（TSV）和 text/html。优先使用
 * text/plain 可以保留原始单元格内容；某些浏览器/桌面壳只给 HTML 时，再用
 * 受限的字符串转换恢复行列，不把不可信 HTML 交给 DOM 或富文本编辑器。
 */
export const getPastedClipboardText = (plainText: string, html: string): string => {
  if (plainText.trim().length > 0) return plainText
  if (!html || html.length > 2_000_000) return plainText

  const converted = html
    .replace(/>\s+</g, '><')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(?:script|style|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style|noscript)\s*>/giu, '')
    .replace(/<\s*br\s*\/?>/giu, '\n')
    .replace(/<\s*\/\s*(?:td|th)\s*>/giu, '\t')
    .replace(/<\s*\/\s*tr\s*>/giu, '\n')
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|section|article|blockquote)\s*>/giu, '\n')
    .replace(/<\s*li\b[^>]*>/giu, '• ')
    .replace(/<[^>]*>/g, '')

  const lines = decodeClipboardHtmlText(converted).trim()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))

  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  return lines.join('\n')
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
