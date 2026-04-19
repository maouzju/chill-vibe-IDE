import { access, readdir, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ChatRequest, Provider, SlashCommand } from '../shared/schema.js'
import { parseSlashCommandInput } from '../shared/slash-commands.js'

export type DiscoveredProviderSkill = SlashCommand & {
  source: 'skill'
  skillProvider: Provider
  skillPath: string
}

type SkillMetadata = {
  name: string
  description?: string
}

const skillNamePattern = /^[a-z0-9][a-z0-9_-]*$/i
const skillReadConcurrency = 8

const providerSkillDirectoryNames: Record<Provider, string> = {
  codex: '.codex',
  claude: '.claude',
}

const providerConfigHomeEnvNames: Record<Provider, string[]> = {
  codex: ['CODEX_HOME'],
  claude: ['CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'],
}

const oppositeProvider = (provider: Provider): Provider =>
  provider === 'codex' ? 'claude' : 'codex'

export const getReusableSkillProviders = (
  provider: Provider,
  crossProviderSkillReuseEnabled = true,
): Provider[] =>
  crossProviderSkillReuseEnabled ? [provider, oppositeProvider(provider)] : [provider]

const normalizeWorkspacePath = (workspacePath: string) => workspacePath.trim()

const getWorkspaceSkillRoot = (workspacePath: string, provider: Provider) =>
  path.join(normalizeWorkspacePath(workspacePath), providerSkillDirectoryNames[provider], 'skills')

const getHomePathCandidates = (env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()) => [
  homeDir,
  env.HOME,
  env.USERPROFILE,
]

const getProviderSkillRoots = (
  workspacePath: string,
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const providerDirectoryName = providerSkillDirectoryNames[provider]
  const roots = [getWorkspaceSkillRoot(workspacePath, provider)]

  for (const homePath of getHomePathCandidates(env)) {
    if (homePath?.trim()) {
      roots.push(path.join(homePath, providerDirectoryName, 'skills'))
    }
  }

  for (const envName of providerConfigHomeEnvNames[provider]) {
    const configHome = env[envName]?.trim()
    if (!configHome) {
      continue
    }

    roots.push(path.join(configHome, 'skills'))

    if (path.basename(configHome).toLowerCase() === 'skills') {
      roots.push(configHome)
    }
  }

  return roots
}

const pathExists = async (filePath: string) => {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const isSubPathOrSame = (candidatePath: string, parentPath: string) => {
  const relative = path.relative(parentPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const getUniqueExistingRoots = async (roots: string[]) => {
  const result: string[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    if (!root.trim()) {
      continue
    }

    const resolvedRoot = path.resolve(root)
    const key = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot

    if (seen.has(key) || !(await pathExists(resolvedRoot))) {
      continue
    }

    try {
      const stats = await stat(resolvedRoot)
      if (!stats.isDirectory()) {
        continue
      }
    } catch {
      continue
    }

    seen.add(key)
    result.push(resolvedRoot)
  }

  return result
}

const parseYamlScalar = (value: string) =>
  value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()

const readFoldedFrontmatterValue = (lines: string[], startIndex: number) => {
  const chunks: string[] = []
  let index = startIndex + 1

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (/^\s+\S/.test(line)) {
      chunks.push(line.trim())
      index += 1
      continue
    }
    break
  }

  return chunks.join(' ').trim()
}

const parseFrontmatter = (contents: string): Partial<SkillMetadata> => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)
  if (!match) {
    return {}
  }

  const lines = (match[1] ?? '').split(/\r?\n/)
  const metadata: Partial<SkillMetadata> = {}

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const keyValueMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!keyValueMatch) {
      continue
    }

    const key = keyValueMatch[1]
    const rawValue = keyValueMatch[2] ?? ''
    const value =
      rawValue.trim() === '>' || rawValue.trim() === '|'
        ? readFoldedFrontmatterValue(lines, index)
        : parseYamlScalar(rawValue)

    if (key === 'name' && value) {
      metadata.name = value
    }

    if (key === 'description' && value) {
      metadata.description = value
    }
  }

  return metadata
}

const getFirstMarkdownHeading = (contents: string) =>
  contents
    .split(/\r?\n/)
    .map((line) => /^#\s+(.+)$/.exec(line)?.[1]?.trim() ?? '')
    .find(Boolean)

const parseSkillMetadata = (contents: string, fallbackName: string): SkillMetadata => {
  const frontmatter = parseFrontmatter(contents)
  const name = frontmatter.name?.trim() || fallbackName
  const description = frontmatter.description?.trim() || getFirstMarkdownHeading(contents)

  return {
    name,
    description,
  }
}

const readSkill = async (
  provider: Provider,
  skillPath: string,
  fallbackName: string,
): Promise<DiscoveredProviderSkill | null> => {
  try {
    const contents = await readFile(skillPath, 'utf8')
    const metadata = parseSkillMetadata(contents, fallbackName)
    const name = metadata.name.trim().toLowerCase()

    if (!skillNamePattern.test(name)) {
      return null
    }

    return {
      name,
      description: metadata.description,
      source: 'skill',
      skillProvider: provider,
      skillPath,
    }
  } catch {
    return null
  }
}

const discoverSkillPathsUnderRoot = async (root: string) => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const directSkillPaths: Array<{ skillPath: string; fallbackName: string }> = []
  const nestedRoots: string[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const dirPath = path.join(root, entry.name)
    const skillPath = path.join(dirPath, 'SKILL.md')

    if (await pathExists(skillPath)) {
      directSkillPaths.push({
        skillPath,
        fallbackName: entry.name,
      })
      continue
    }

    if (entry.name.startsWith('.')) {
      nestedRoots.push(dirPath)
    }
  }

  for (const nestedRoot of nestedRoots) {
    const nestedEntries = await readdir(nestedRoot, { withFileTypes: true }).catch(() => [])

    for (const entry of nestedEntries) {
      if (!entry.isDirectory()) {
        continue
      }

      const dirPath = path.join(nestedRoot, entry.name)
      const skillPath = path.join(dirPath, 'SKILL.md')

      if (await pathExists(skillPath)) {
        directSkillPaths.push({
          skillPath,
          fallbackName: entry.name,
        })
      }
    }
  }

  return directSkillPaths
}

const discoverProviderSkillsForProvider = async (
  workspacePath: string,
  provider: Provider,
): Promise<DiscoveredProviderSkill[]> => {
  const roots = await getUniqueExistingRoots(getProviderSkillRoots(workspacePath, provider))
  const skillCandidates: Array<{ skillPath: string; fallbackName: string }> = []

  for (const root of roots) {
    const rootCandidates = await discoverSkillPathsUnderRoot(root)
    for (const candidate of rootCandidates) {
      const resolvedSkillPath = path.resolve(candidate.skillPath)
      if (isSubPathOrSame(resolvedSkillPath, root)) {
        skillCandidates.push({
          ...candidate,
          skillPath: resolvedSkillPath,
        })
      }
    }
  }

  const skills: DiscoveredProviderSkill[] = []

  for (let index = 0; index < skillCandidates.length; index += skillReadConcurrency) {
    const batch = skillCandidates.slice(index, index + skillReadConcurrency)
    const batchSkills = await Promise.all(
      batch.map((candidate) => readSkill(provider, candidate.skillPath, candidate.fallbackName)),
    )

    for (const skill of batchSkills) {
      if (skill) {
        skills.push(skill)
      }
    }
  }

  return skills
}

export const discoverProviderSkills = async (
  workspacePath: string,
  providers: readonly Provider[],
): Promise<DiscoveredProviderSkill[]> => {
  const seen = new Set<string>()
  const result: DiscoveredProviderSkill[] = []

  for (const provider of providers) {
    const skills = await discoverProviderSkillsForProvider(workspacePath, provider)

    for (const skill of skills) {
      if (seen.has(skill.name)) {
        continue
      }

      seen.add(skill.name)
      result.push(skill)
    }
  }

  return result
}

export const resolvePromptSkill = async (
  request: Pick<ChatRequest, 'provider' | 'workspacePath' | 'prompt'> & {
    crossProviderSkillReuseEnabled?: boolean
  },
): Promise<DiscoveredProviderSkill | null> => {
  const parsed = parseSlashCommandInput(request.prompt)
  if (!parsed?.name) {
    return null
  }

  const skills = await discoverProviderSkills(
    request.workspacePath,
    getReusableSkillProviders(request.provider, request.crossProviderSkillReuseEnabled),
  )

  return skills.find((skill) => skill.name === parsed.name) ?? null
}

export const buildSkillSlashPrompt = (
  request: Pick<ChatRequest, 'provider' | 'prompt' | 'language'>,
  skill: DiscoveredProviderSkill,
) => {
  const parsed = parseSlashCommandInput(request.prompt)
  if (!parsed || parsed.name !== skill.name) {
    return request.prompt
  }

  const description = skill.description ? `\nDescription: ${skill.description}` : ''
  const userPrompt = parsed.args.trim()
  const instruction =
    request.language === 'en'
      ? [
          `Use $${skill.name} at ${skill.skillPath} while handling this request.`,
          `Read that SKILL.md first and follow its workflow. Reusing the skill does not switch provider CLIs; this run stays on ${request.provider}.`,
          `Skill source: ${skill.skillProvider}.${description}`,
        ].join('\n')
      : [
          `使用 $${skill.name}（路径：${skill.skillPath}）来处理这次请求。`,
          `请先读取这个 SKILL.md，并按照其中的工作流执行。复用 skill 不代表切换 CLI；本次运行仍使用当前 Provider。`,
          `Skill 来源：${skill.skillProvider}。${description}`,
        ].join('\n')

  if (!userPrompt) {
    return instruction
  }

  return request.language === 'en'
    ? `${instruction}\n\nUser request:\n${userPrompt}`
    : `${instruction}\n\n用户请求：\n${userPrompt}`
}

export const expandSkillSlashPrompt = async (
  request: Pick<ChatRequest, 'provider' | 'workspacePath' | 'language' | 'prompt'> & {
    crossProviderSkillReuseEnabled?: boolean
  },
) => {
  const skill = await resolvePromptSkill(request)
  return skill ? buildSkillSlashPrompt(request, skill) : request.prompt
}

export const buildCrossProviderSkillInstructions = async (
  request: Pick<ChatRequest, 'provider' | 'workspacePath' | 'language'> & {
    crossProviderSkillReuseEnabled?: boolean
  },
) => {
  if (request.crossProviderSkillReuseEnabled === false) {
    return ''
  }

  const provider = oppositeProvider(request.provider)
  const skills = await discoverProviderSkills(request.workspacePath, [provider])

  if (skills.length === 0) {
    return ''
  }

  const skillList = skills
    .map((skill) => {
      const description = skill.description ? ` - ${skill.description}` : ''
      return `- ${skill.name} (${skill.skillProvider})${description}\n  Path: ${skill.skillPath}`
    })
    .join('\n')

  if (request.language === 'en') {
    return [
      'Cross-provider skill reuse is enabled.',
      `This run uses ${request.provider}, but it can also reuse these ${provider} skills from local SKILL.md files:`,
      skillList,
      'When the user names one of these skills or the task clearly matches it, read that SKILL.md first and follow its workflow. Reusing a skill does not switch provider CLIs; it only reuses the local instructions.',
    ].join('\n')
  }

  return [
    '跨 Provider Skill 复用已开启。',
    `本次运行使用 ${request.provider}，但也可以复用这些 ${provider} 的本地 SKILL.md：`,
    skillList,
    '当用户点名某个 skill，或任务明显匹配它时，先读取对应 SKILL.md，再按其中流程执行。复用 skill 不代表切换 CLI，只是复用本地说明文件。',
  ].join('\n')
}
