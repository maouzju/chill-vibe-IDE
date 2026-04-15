import { getDiffLineClassName } from './git-utils'

type DiffRow = {
  key: string
  kind: 'meta' | 'hunk' | 'context' | 'added' | 'removed'
  oldLineNumber: number | null
  newLineNumber: number | null
  content: string
}

const buildDiffRows = (patch: string): DiffRow[] => {
  const rows: DiffRow[] = []
  const lines = patch.split(/\r?\n/)
  let previousLine = 0
  let nextLine = 0

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    if (line.startsWith('@@')) {
      const hunkMatch = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (hunkMatch) {
        previousLine = Number(hunkMatch[1])
        nextLine = Number(hunkMatch[2])
      }

      rows.push({
        key: `hunk:${index}`,
        kind: 'hunk',
        oldLineNumber: null,
        newLineNumber: null,
        content: line,
      })
      continue
    }

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
      rows.push({
        key: `meta:${index}`,
        kind: 'meta',
        oldLineNumber: null,
        newLineNumber: null,
        content: line,
      })
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      rows.push({
        key: `added:${index}`,
        kind: 'added',
        oldLineNumber: null,
        newLineNumber: nextLine,
        content: line.slice(1),
      })
      nextLine += 1
      continue
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      rows.push({
        key: `removed:${index}`,
        kind: 'removed',
        oldLineNumber: previousLine,
        newLineNumber: null,
        content: line.slice(1),
      })
      previousLine += 1
      continue
    }

    if (line.startsWith(' ')) {
      rows.push({
        key: `context:${index}`,
        kind: 'context',
        oldLineNumber: previousLine,
        newLineNumber: nextLine,
        content: line.slice(1),
      })
      previousLine += 1
      nextLine += 1
      continue
    }

    rows.push({
      key: `meta:${index}`,
      kind: 'meta',
      oldLineNumber: null,
      newLineNumber: null,
      content: line,
    })
  }

  return rows
}

export const GitDiffPreview = ({
  patch,
  emptyTitle,
  emptyCopy,
}: {
  patch?: string
  emptyTitle: string
  emptyCopy: string
}) => {
  if (!patch?.trim()) {
    return (
      <div className="git-tool-diff-empty">
        <strong>{emptyTitle}</strong>
        <p>{emptyCopy}</p>
      </div>
    )
  }

  const rows = buildDiffRows(patch)

  return (
    <div className="structured-diff-block git-tool-diff-block">
      {rows.map((row) => (
        <div
          key={row.key}
          className={`${getDiffLineClassName(
            row.kind === 'added'
              ? '+'
              : row.kind === 'removed'
                ? '-'
                : row.kind === 'hunk'
                  ? '@@'
                  : row.content,
          )} git-tool-diff-row`}
        >
          <span className="git-tool-diff-line-number" aria-hidden="true">
            {row.oldLineNumber ?? ''}
          </span>
          <span className="git-tool-diff-line-number" aria-hidden="true">
            {row.newLineNumber ?? ''}
          </span>
          <code className="git-tool-diff-code">{row.content || ' '}</code>
        </div>
      ))}
    </div>
  )
}
