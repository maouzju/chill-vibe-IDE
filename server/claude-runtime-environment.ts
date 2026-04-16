import { access } from 'node:fs/promises'
import path from 'node:path'

type ResolveClaudeRuntimeEnvironmentOptions = {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const splitPathEntries = (value: string | undefined) =>
  (value ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)

const windowsAbsolutePathPattern = /^[A-Za-z]:[\\/]/
const uncPathPattern = /^\\\\/

const isWindowsLikePath = (value: string) =>
  windowsAbsolutePathPattern.test(value) || uncPathPattern.test(value)

const getPathModuleForEntry = (value: string) =>
  isWindowsLikePath(value) ? path.win32 : path.posix

const normalizeCandidatePath = (value: string) => getPathModuleForEntry(value).normalize(value)

const collectPortableGitDriveLetters = (entries: string[]) => {
  const letters = new Set<string>(['C'])

  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z]):[\\/]/)
    if (match?.[1]) {
      letters.add(match[1].toUpperCase())
    }
  }

  return [...letters]
}

const buildPathDerivedCandidates = (entries: string[]) =>
  entries.flatMap((entry) => {
    const pathModule = getPathModuleForEntry(entry)
    const normalized = pathModule.normalize(entry)
    const basename = pathModule.basename(normalized).toLowerCase()

    if (basename === 'bash.exe') {
      return [normalized]
    }

    if (basename === 'bin') {
      return [pathModule.join(normalized, 'bash.exe')]
    }

    if (basename === 'cmd') {
      return [pathModule.join(normalized, '..', 'bin', 'bash.exe')]
    }

    return []
  })

const buildCommonInstallCandidates = (env: NodeJS.ProcessEnv, entries: string[]) => {
  const candidates = [
    env.ProgramFiles ? path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe') : null,
    env['ProgramFiles(x86)']
      ? path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe')
      : null,
    env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ]

  for (const driveLetter of collectPortableGitDriveLetters(entries)) {
    candidates.push(`${driveLetter}:\\PortableGit\\bin\\bash.exe`)
  }

  return candidates.filter((candidate): candidate is string => Boolean(candidate))
}

const dedupeWindowsPaths = (paths: string[]) => {
  const seen = new Set<string>()

  return paths.filter((candidate) => {
    const key = normalizeCandidatePath(candidate).toLowerCase()
    if (seen.has(key)) {
      return false
    }

    seen.add(key)
    return true
  })
}

const resolveExistingPath = async (candidates: string[]) => {
  for (const candidate of dedupeWindowsPaths(candidates)) {
    try {
      await access(candidate)
      return normalizeCandidatePath(candidate)
    } catch {
      // Try the next candidate.
    }
  }

  return null
}

export const resolveClaudeRuntimeEnvironment = async ({
  env = process.env,
  platform = process.platform,
}: ResolveClaudeRuntimeEnvironmentOptions = {}): Promise<NodeJS.ProcessEnv> => {
  if (platform !== 'win32') {
    return env
  }

  const pathEntries = splitPathEntries(env.PATH)
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH?.trim(),
    env.SHELL?.trim(),
    ...buildPathDerivedCandidates(pathEntries),
    ...buildCommonInstallCandidates(env, pathEntries),
  ].filter((candidate): candidate is string => Boolean(candidate))

  const bashPath = await resolveExistingPath(candidates)
  if (!bashPath) {
    return env
  }

  return {
    ...env,
    CLAUDE_CODE_GIT_BASH_PATH: bashPath,
    SHELL: env.SHELL?.trim() || bashPath,
  }
}
