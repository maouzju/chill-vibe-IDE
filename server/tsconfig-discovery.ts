import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { ensureWithinWorkspace } from './file-system.js'

// tsconfig.json is JSONC — strip comments outside of strings before parsing.
const stripJsonComments = (input: string): string => {
  let output = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      output += char
      if (char === '\\' && next !== undefined) {
        output += next
        index += 1
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === '/' && next === '/') {
      inLineComment = true
      continue
    }

    if (char === '/' && next === '*') {
      inBlockComment = true
      index += 1
      continue
    }

    output += char
  }

  return output
}

const removeTrailingCommas = (input: string): string => input.replace(/,(\s*[}\]])/g, '$1')

const parseJsonc = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    try {
      return JSON.parse(removeTrailingCommas(stripJsonComments(raw)))
    } catch {
      return null
    }
  }
}

export type NearestTsconfigResponse = {
  compilerOptions: Record<string, unknown> | null
}

/**
 * Walks from the file's directory up to the workspace root looking for the
 * nearest tsconfig.json and returns its raw compilerOptions. The mapping into
 * Monaco's compiler option shape happens client-side.
 */
export const readNearestTsconfig = async (request: {
  workspacePath: string
  relativePath: string
}): Promise<NearestTsconfigResponse> => {
  const targetPath = ensureWithinWorkspace(request.workspacePath, request.relativePath)
  const workspaceRoot = path.resolve(request.workspacePath)
  let currentDir = path.dirname(targetPath)

  while (currentDir.startsWith(workspaceRoot)) {
    const candidate = path.join(currentDir, 'tsconfig.json')
    const raw = await readFile(candidate, 'utf8').catch(() => null)

    if (raw !== null) {
      const parsed = parseJsonc(raw)
      const compilerOptions =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { compilerOptions?: unknown }).compilerOptions
          : null

      return {
        compilerOptions:
          compilerOptions && typeof compilerOptions === 'object' && !Array.isArray(compilerOptions)
            ? (compilerOptions as Record<string, unknown>)
            : null,
      }
    }

    if (currentDir === workspaceRoot) {
      break
    }

    const parent = path.dirname(currentDir)
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  return { compilerOptions: null }
}
