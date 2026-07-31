// Tool-card detail rows, split out of StructuredBlocks.tsx so they can be unit
// tested and imported without tripping the react-refresh "components only" rule.

import type { AppLanguage } from '../../shared/schema'
import { resolveOpenableFilePath } from './structured-file-paths'

// openPath/openLine are only set for details whose value is a real file path the
// CLI reported in its tool input. That is structured data from the provider, not
// a guess made from prose, so it can be trusted as a click target.
export type ToolDetail = {
  label: string
  value: string
  openPath?: string
  openLine?: number
}

const parseToolInputLineNumber = (value: string | undefined) => {
  if (!value) {
    return null
  }

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed < 1) {
    return null
  }

  return parsed
}

export const buildReadLinePresentation = (
  language: AppLanguage,
  toolInput?: Record<string, string>,
): { detail: ToolDetail; summarySuffix: string } | null => {
  if (!toolInput) {
    return null
  }

  const en = language === 'en'
  const offset = parseToolInputLineNumber(toolInput.offset)
  const limit = parseToolInputLineNumber(toolInput.limit)

  if (offset !== null && limit !== null) {
    const end = offset + limit - 1
    return {
      detail: {
        label: en ? 'lines' : '行',
        value: `${offset}-${end}`,
      },
      summarySuffix: en ? ` (lines ${offset}-${end})` : `（第 ${offset}-${end} 行）`,
    }
  }

  if (offset !== null) {
    return {
      detail: {
        label: en ? 'lines' : '行',
        value: String(offset),
      },
      summarySuffix: en ? ` (from line ${offset})` : `（从第 ${offset} 行）`,
    }
  }

  if (limit !== null) {
    return {
      detail: {
        label: en ? 'lines' : '行',
        value: `1-${limit}`,
      },
      summarySuffix: en ? ` (lines 1-${limit})` : `（第 1-${limit} 行）`,
    }
  }

  return null
}

const buildFilePathDetail = (
  language: AppLanguage,
  filePath: string,
  workspacePath: string | undefined,
  line?: number,
): ToolDetail => {
  const openPath = workspacePath ? resolveOpenableFilePath(workspacePath, filePath) : null

  return {
    label: language === 'en' ? 'file' : '文件',
    value: filePath,
    openPath: openPath ?? undefined,
    openLine: openPath ? line : undefined,
  }
}

export const buildToolDetails = (
  language: AppLanguage,
  toolName: string,
  toolInput?: Record<string, string>,
  workspacePath?: string,
): ToolDetail[] => {
  if (!toolInput) return []
  const en = language === 'en'

  if (toolName === 'Read') {
    const details: ToolDetail[] = []
    const offset = parseToolInputLineNumber(toolInput.offset)
    if (toolInput.file_path) {
      details.push(buildFilePathDetail(language, toolInput.file_path, workspacePath, offset ?? undefined))
    }
    const readLinePresentation = buildReadLinePresentation(language, toolInput)
    if (readLinePresentation) details.push(readLinePresentation.detail)
    return details
  }

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const targetPath = toolInput.file_path ?? toolInput.notebook_path

      return targetPath ? [buildFilePathDetail(language, targetPath, workspacePath)] : []
    }
    case 'Glob': {
      const details: ToolDetail[] = []
      if (toolInput.pattern) details.push({ label: en ? 'pattern' : '模式', value: toolInput.pattern })
      if (toolInput.path) details.push({ label: en ? 'in' : '目录', value: toolInput.path })
      return details
    }
    case 'Grep': {
      const details: ToolDetail[] = []
      if (toolInput.pattern) details.push({ label: en ? 'pattern' : '模式', value: toolInput.pattern })
      if (toolInput.glob) details.push({ label: en ? 'files' : '文件', value: toolInput.glob })
      if (toolInput.path) details.push({ label: en ? 'in' : '目录', value: toolInput.path })
      return details
    }
    case 'Bash':
    case 'PowerShell': {
      const details: ToolDetail[] = []
      if (toolInput.command) details.push({ label: en ? 'command' : '命令', value: toolInput.command })
      if (toolInput.description) details.push({ label: en ? 'description' : '说明', value: toolInput.description })
      return details
    }
    case 'WebFetch': {
      const details: ToolDetail[] = []
      if (toolInput.url) details.push({ label: 'URL', value: toolInput.url })
      return details
    }
    case 'WebSearch': {
      const details: ToolDetail[] = []
      if (toolInput.query) details.push({ label: en ? 'query' : '搜索', value: toolInput.query })
      return details
    }
    default:
      return []
  }
}
