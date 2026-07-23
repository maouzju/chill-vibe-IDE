export type StructuredDiffPreviewLine = {
  key: string
  kind: 'added' | 'removed' | 'context'
  marker: '+' | '-' | ' '
  content: string
}

export const structuredDiffPreviewMaxRows = 80

const diffMetadataPrefixes = [
  'diff --git ',
  'index ',
  'new file mode ',
  'deleted file mode ',
  'similarity index ',
  'rename from ',
  'rename to ',
  '--- ',
  '+++ ',
]

export const buildStructuredDiffPreviewLines = (patch: string): StructuredDiffPreviewLine[] => {
  const rows: StructuredDiffPreviewLine[] = []
  let lineStart = 0
  let lineIndex = 0

  while (lineStart <= patch.length && rows.length < structuredDiffPreviewMaxRows) {
    const newlineIndex = patch.indexOf('\n', lineStart)
    const lineEnd = newlineIndex >= 0 ? newlineIndex : patch.length
    const rawLine = patch.slice(lineStart, lineEnd)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const index = lineIndex
    lineIndex += 1

    if (!line || diffMetadataPrefixes.some((prefix) => line.startsWith(prefix)) || line.startsWith('@@')) {
      // Metadata does not consume the bounded inline DOM budget.
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push({
        key: `added:${index}`,
        kind: 'added',
        marker: '+',
        content: line.slice(1),
      })
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push({
        key: `removed:${index}`,
        kind: 'removed',
        marker: '-',
        content: line.slice(1),
      })
    } else {
      rows.push({
        key: `context:${index}`,
        kind: 'context',
        marker: ' ',
        content: line.startsWith(' ') ? line.slice(1) : line,
      })
    }

    if (newlineIndex < 0) {
      break
    }
    lineStart = newlineIndex + 1
  }

  return rows
}

