import type { StreamEditedFile } from '../shared/schema.js'

type StreamEditedFileDraft = {
  path?: string
  originalPath?: string
  kind?: string
  patch?: string
  addedLines?: number
  removedLines?: number
}

const editedFileKinds = new Set<StreamEditedFile['kind']>([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])

const normalizeDiffText = (value: string | null) => value?.replace(/\r\n/g, '\n') ?? null

const splitContentLines = (value: string | null) => {
  const normalized = normalizeDiffText(value)

  if (!normalized) {
    return []
  }

  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  return trimmed ? trimmed.split('\n') : []
}

const patchLooksLikeUnifiedDiff = (patch: string) => {
  let hasOldHeader = false
  let hasNewHeader = false

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      return true
    }

    if (line.startsWith('diff --git ')) {
      return true
    }

    if (line.startsWith('--- ')) {
      hasOldHeader = true
    } else if (line.startsWith('+++ ')) {
      hasNewHeader = true
    }
  }

  return hasOldHeader && hasNewHeader
}

export const countStructuredPatchLines = (patch: string) =>
  patch.split(/\r?\n/).reduce(
    (summary, line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return summary
      }

      if (line.startsWith('+')) {
        summary.addedLines += 1
      } else if (line.startsWith('-')) {
        summary.removedLines += 1
      }

      return summary
    },
    { addedLines: 0, removedLines: 0 },
  )

export const buildSyntheticPatch = (oldContent: string | null, newContent: string | null) => {
  const normalizedOld = normalizeDiffText(oldContent)
  const normalizedNew = normalizeDiffText(newContent)

  if ((normalizedOld ?? null) === (normalizedNew ?? null)) {
    return ''
  }

  const oldLines = splitContentLines(normalizedOld)
  const newLines = splitContentLines(normalizedNew)
  const oldStart = oldLines.length > 0 ? 1 : 0
  const newStart = newLines.length > 0 ? 1 : 0

  return [
    `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n')
}

const normalizeEditedFileKind = (
  value: string | undefined,
  path: string,
  originalPath: string | undefined,
  addedLines: number,
  removedLines: number,
): StreamEditedFile['kind'] => {
  const normalized = value?.trim().toLowerCase()

  switch (normalized) {
    case 'modified':
    case 'edit':
    case 'edited':
    case 'changed':
    case 'change':
    case 'diff':
      return 'modified'
    case 'added':
    case 'add':
    case 'created':
    case 'create':
    case 'new':
    case 'write':
      return 'added'
    case 'deleted':
    case 'delete':
    case 'removed':
    case 'remove':
      return 'deleted'
    case 'renamed':
    case 'rename':
      return 'renamed'
    case 'copied':
    case 'copy':
      return 'copied'
    case 'typechange':
      return 'typechange'
    case 'untracked':
      return 'untracked'
    case 'conflicted':
    case 'conflict':
      return 'conflicted'
    default:
      break
  }

  if (originalPath && originalPath !== path) {
    return 'renamed'
  }

  if (removedLines === 0 && addedLines > 0) {
    return 'added'
  }

  if (addedLines === 0 && removedLines > 0) {
    return 'deleted'
  }

  return 'modified'
}

export const finalizeStructuredEditedFile = (
  draft: StreamEditedFileDraft,
): StreamEditedFile | null => {
  const path = draft.path?.trim() || draft.originalPath?.trim()

  if (!path) {
    return null
  }

  const rawPatch = draft.patch?.trim() ?? ''
  const rawPatchSummary = rawPatch ? countStructuredPatchLines(rawPatch) : { addedLines: 0, removedLines: 0 }
  const provisionalAddedLines = draft.addedLines ?? rawPatchSummary.addedLines
  const provisionalRemovedLines = draft.removedLines ?? rawPatchSummary.removedLines
  const provisionalKind = normalizeEditedFileKind(
    draft.kind,
    path,
    draft.originalPath,
    provisionalAddedLines,
    provisionalRemovedLines,
  )
  const patch =
    rawPatch && !patchLooksLikeUnifiedDiff(rawPatch)
      ? provisionalKind === 'added' || provisionalKind === 'untracked' || provisionalKind === 'copied'
        ? buildSyntheticPatch(null, rawPatch)
        : provisionalKind === 'deleted'
          ? buildSyntheticPatch(rawPatch, null)
          : rawPatch
      : rawPatch
  const patchSummary = patch ? countStructuredPatchLines(patch) : { addedLines: 0, removedLines: 0 }
  const addedLines = draft.addedLines ?? patchSummary.addedLines
  const removedLines = draft.removedLines ?? patchSummary.removedLines
  const kind = normalizeEditedFileKind(draft.kind, path, draft.originalPath, addedLines, removedLines)

  if (!editedFileKinds.has(kind)) {
    return null
  }

  const originalPath = draft.originalPath?.trim() || undefined

  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    kind,
    addedLines,
    removedLines,
    patch,
  }
}
