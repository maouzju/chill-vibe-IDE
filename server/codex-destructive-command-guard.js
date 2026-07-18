import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const shellToolPattern = /^(?:Bash|shell|shell_command|exec_command|write_stdin)$/i
const powershellDeletePattern = /(?:^|[;&|{}]\s*)Remove-Item\b/i
const posixDeletePattern = /(?:^|[;&|]\s*)rm\s+-[^\r\n;&|]*r/i
const cmdRmdirPattern = /(?:^|[;&|]\s*)rmdir\s+[^\r\n;&|]*\/s/i
const cmdDeletePattern = /(?:^|[;&|]\s*)del\s+[^\r\n;&|]*\/s/i
const pythonRmtreePattern = /\bshutil\.rmtree\s*\(/i
const nodeRecursiveDeletePattern = /\b(?:fs\.)?(?:rm|rmSync)\s*\([^)]*recursive\s*:\s*true/is
const dotnetRecursiveDeletePattern = /\b(?:Directory|System\.IO\.Directory)\.Delete\s*\([^,]+,\s*true\s*\)/i
const powershellHomeAssignmentPattern = /\$home\s*=/i
const automaticTemporaryCleanupPattern = /\b(?:tempfile\.)?TemporaryDirectory\s*\(/i
const bindMountPattern = /\b(?:mount_bind\s*\(|mount\s+(?:--bind\b|-o\s+bind\b)|bind[-_ ]mount)\b/i
const unresolvedVariablePattern = /(?:\$\(|\$\{[^}\r\n]+\}|\$(?:env:)?[A-Za-z_][\w:]*|%[^%\r\n]+%|@\s*\()/i
const runtimeExpansionPattern = /[`]|^~[^\\/]/
const wildcardPattern = /[*?\[\]]/

const normalizeCommand = (value) => {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === 'string').join(' ').trim()
  }

  return ''
}

const stripOuterQuotes = (value) => {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const tokenize = (value) => {
  const tokens = []
  const pattern = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s]+/g
  for (const match of value.matchAll(pattern)) {
    tokens.push(stripOuterQuotes(match[0]))
  }
  return tokens
}

const extractRmTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)rm\s+([^\r\n;&|]+)/gi
  for (const match of command.matchAll(pattern)) {
    for (const token of tokenize(match[1])) {
      if (!token.startsWith('-')) {
        targets.push(token)
      }
    }
  }
  return targets
}

const extractPowerShellTargets = (command) => {
  const targets = []
  const pattern = /Remove-Item\s+([^;\r\n}]+)/gi
  for (const match of command.matchAll(pattern)) {
    const tokens = tokenize(match[1])
    const explicitPathIndex = tokens.findIndex((token) => /^-(?:LiteralPath|Path)$/i.test(token))
    if (explicitPathIndex >= 0 && tokens[explicitPathIndex + 1]) {
      targets.push(tokens[explicitPathIndex + 1])
      continue
    }

    const positional = tokens.find((token) => !token.startsWith('-'))
    if (positional) {
      targets.push(positional)
    }
  }
  return targets
}

const extractCmdTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)(?:rmdir|del)\s+([^\r\n;&|]+)/gi
  for (const match of command.matchAll(pattern)) {
    const positional = tokenize(match[1]).find((token) => !/^\/[a-z]+$/i.test(token))
    if (positional) {
      targets.push(positional)
    }
  }
  return targets
}

const extractFunctionTargets = (command) => {
  const targets = []
  const patterns = [
    /shutil\.rmtree\s*\(\s*([^,)]+)/gi,
    /(?:fs\.)?(?:rm|rmSync)\s*\(\s*([^,)]+)/gi,
    /(?:Directory|System\.IO\.Directory)\.Delete\s*\(\s*([^,)]+)/gi,
  ]

  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      targets.push(stripOuterQuotes(match[1]))
    }
  }
  return targets
}

const normalizeComparablePath = (value, pathApi) => {
  const normalized = pathApi.normalize(value)
  const withoutTrailing = normalized.length > pathApi.parse(normalized).root.length
    ? normalized.replace(/[\\/]+$/g, '')
    : normalized
  return process.platform === 'win32' || pathApi === path.win32
    ? withoutTrailing.toLowerCase()
    : withoutTrailing
}

const isSamePath = (left, right, pathApi) =>
  normalizeComparablePath(left, pathApi) === normalizeComparablePath(right, pathApi)

const pathContains = (parent, child, pathApi) => {
  const normalizedParent = normalizeComparablePath(parent, pathApi)
  const normalizedChild = normalizeComparablePath(child, pathApi)
  if (normalizedParent === normalizedChild) {
    return true
  }
  const relative = pathApi.relative(normalizedParent, normalizedChild)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative)
}

const expandKnownHomeVariables = (value, protectedHome) => {
  let expanded = value.trim()
  if (!protectedHome) {
    return expanded
  }

  expanded = expanded
    .replace(/\$env:(?:HOME|USERPROFILE)\b/gi, protectedHome)
    .replace(/\$\{(?:HOME|USERPROFILE)\}/gi, protectedHome)
    .replace(/\$(?:HOME|USERPROFILE)\b/gi, protectedHome)
    .replace(/%(?:HOME|USERPROFILE)%/gi, protectedHome)

  if (expanded === '~') {
    return protectedHome
  }
  if (/^~[\\/]/.test(expanded)) {
    return path.join(protectedHome, expanded.slice(2))
  }
  return expanded
}

const resolveExistingPath = (candidate, pathApi) => {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    let current = candidate
    const suffix = []
    while (current && current !== pathApi.dirname(current)) {
      if (fs.existsSync(current)) {
        try {
          return pathApi.join(fs.realpathSync.native(current), ...suffix.reverse())
        } catch {
          break
        }
      }
      suffix.push(pathApi.basename(current))
      current = pathApi.dirname(current)
    }
    return candidate
  }
}

const readLinuxMountPoints = (platform) => {
  if (platform !== 'linux') {
    return []
  }

  try {
    return fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        const encodedMountPoint = line.split(' ')[4]
        if (!encodedMountPoint) {
          return []
        }
        return [encodedMountPoint.replace(/\\([0-7]{3})/g, (_match, octal) =>
          String.fromCharCode(Number.parseInt(octal, 8)))]
      })
  } catch {
    return []
  }
}

const assessTarget = (rawTarget, context) => {
  const pathApi = context.platform === 'win32' ? path.win32 : path.posix
  const stripped = stripOuterQuotes(rawTarget)
  const expanded = expandKnownHomeVariables(stripped, context.protectedHome)

  if (!expanded || expanded === '.' || expanded === '..') {
    return '删除目标是工作区根或其上级，已阻止。'
  }
  if (unresolvedVariablePattern.test(expanded)) {
    return `删除目标仍包含未解析变量：${stripped}`
  }
  if (runtimeExpansionPattern.test(expanded)) {
    return `删除目标包含运行时展开表达式，范围无法安全确认：${stripped}`
  }
  if (wildcardPattern.test(expanded)) {
    return `递归删除目标包含通配符，范围无法安全确认：${stripped}`
  }
  if (!pathApi.isAbsolute(expanded)) {
    return `递归删除必须使用明确的工作区内绝对路径，避免工具 workdir 或中途切换目录扩大范围：${stripped}`
  }

  const candidate = resolveExistingPath(
    pathApi.normalize(expanded),
    pathApi,
  )
  const root = pathApi.parse(candidate).root
  if (isSamePath(candidate, root, pathApi)) {
    return `不能删除文件系统根目录：${candidate}`
  }

  const segments = normalizeComparablePath(candidate, pathApi).split(/[\\/]+/)
  if (segments.includes('.git')) {
    return `不能递归删除 Git 元数据：${candidate}`
  }

  for (const mountPoint of context.mountPoints) {
    if (!mountPoint || !pathApi.isAbsolute(mountPoint)) {
      continue
    }
    const resolvedMountPoint = resolveExistingPath(pathApi.normalize(mountPoint), pathApi)
    if (pathContains(candidate, resolvedMountPoint, pathApi)) {
      return `递归删除会穿过挂载点，已阻止：${resolvedMountPoint}`
    }
  }

  const workspaceRoot = context.workspaceRoot
  const insideWorkspace = Boolean(
    workspaceRoot &&
    !isSamePath(candidate, workspaceRoot, pathApi) &&
    pathContains(workspaceRoot, candidate, pathApi),
  )
  if (workspaceRoot && pathContains(candidate, workspaceRoot, pathApi)) {
    return `删除目标会覆盖工作区根目录：${candidate}`
  }

  if (context.protectedHome) {
    if (pathContains(candidate, context.protectedHome, pathApi)) {
      return `删除目标会覆盖用户主目录：${candidate}`
    }
    if (pathContains(context.protectedHome, candidate, pathApi) && !insideWorkspace) {
      return `不能递归删除工作区之外的用户主目录数据：${candidate}`
    }
  }

  for (const protectedTree of [context.codexHome, context.appDataDir].filter(Boolean)) {
    if (
      pathContains(candidate, protectedTree, pathApi) ||
      pathContains(protectedTree, candidate, pathApi)
    ) {
      return `删除目标位于受保护的数据目录：${candidate}`
    }
  }

  if (!insideWorkspace) {
    return `不能递归删除工作区之外的路径：${candidate}`
  }

  return null
}

const assessGitCommand = (command) => {
  if (/(?:^|[;&|]\s*)git\s+clean\b[^\r\n;&|]*-[^\r\n;&|]*f/i.test(command)) {
    return '已阻止 git clean -f；它可能永久删除未跟踪文件。'
  }
  if (/(?:^|[;&|]\s*)git\s+reset\s+--hard\b/i.test(command)) {
    return '已阻止 git reset --hard；它可能永久丢失未提交修改。'
  }
  if (/(?:^|[;&|]\s*)git\s+restore\b[^\r\n;&|]*(?:\s|--)\.\s*(?:$|[;&|])/i.test(command)) {
    return '已阻止工作区级 git restore；请指定明确文件范围。'
  }
  if (/(?:^|[;&|]\s*)git\s+checkout\s+--\s+\.\s*(?:$|[;&|])/i.test(command)) {
    return '已阻止工作区级 git checkout -- .；它可能丢失未提交修改。'
  }
  return null
}

export const assessCodexToolUse = (input, options = {}) => {
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : ''
  if (!shellToolPattern.test(toolName)) {
    return { allowed: true }
  }

  const command = normalizeCommand(input?.tool_input?.command)
  if (!command) {
    return { allowed: true }
  }

  const gitReason = assessGitCommand(command)
  if (gitReason) {
    return { allowed: false, reason: gitReason }
  }

  if (automaticTemporaryCleanupPattern.test(command) && bindMountPattern.test(command)) {
    return {
      allowed: false,
      reason: '已阻止把绑定挂载放入会自动递归清理的 TemporaryDirectory；异常退出可能删除真实挂载内容。',
    }
  }

  const destructive =
    powershellDeletePattern.test(command) ||
    posixDeletePattern.test(command) ||
    cmdRmdirPattern.test(command) ||
    cmdDeletePattern.test(command) ||
    pythonRmtreePattern.test(command) ||
    nodeRecursiveDeletePattern.test(command) ||
    dotnetRecursiveDeletePattern.test(command)

  if (!destructive) {
    return { allowed: true }
  }

  if (powershellHomeAssignmentPattern.test(command)) {
    return {
      allowed: false,
      reason: '已阻止给 PowerShell 自动变量 $HOME（变量名不区分大小写）赋值后继续递归删除。',
    }
  }

  if (
    /shutil\.rmtree\s*\(\s*(?!["'])/i.test(command) ||
    /(?:fs\.)?(?:rm|rmSync)\s*\(\s*(?!["'])/i.test(command) ||
    /(?:Directory|System\.IO\.Directory)\.Delete\s*\(\s*(?!["'])/i.test(command)
  ) {
    return {
      allowed: false,
      reason: '递归删除目标由运行时表达式计算，Chill Vibe 无法在执行前确认最终路径。',
    }
  }

  const targets = [
    ...extractRmTargets(command),
    ...extractPowerShellTargets(command),
    ...extractCmdTargets(command),
    ...extractFunctionTargets(command),
  ]

  if (targets.length === 0) {
    return {
      allowed: false,
      reason: '检测到递归删除，但无法安全确定最终目标。请改用明确的工作区子目录。',
    }
  }

  const context = {
    platform: options.platform ?? process.platform,
    workspaceRoot:
      options.workspaceRoot ??
      process.env.CHILL_VIBE_PROTECTED_WORKSPACE ??
      (typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd()),
    protectedHome: options.protectedHome ?? process.env.CHILL_VIBE_PROTECTED_HOME ?? '',
    codexHome: options.codexHome ?? process.env.CHILL_VIBE_PROTECTED_CODEX_HOME ?? '',
    appDataDir: options.appDataDir ?? process.env.CHILL_VIBE_PROTECTED_APP_DATA ?? '',
    mountPoints: options.mountPoints ?? readLinuxMountPoints(options.platform ?? process.platform),
  }

  for (const target of targets) {
    const reason = assessTarget(target, context)
    if (reason) {
      return { allowed: false, reason }
    }
  }

  return { allowed: true }
}

const readStdin = async () => {
  let content = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    content += chunk
  }
  return content
}

const runCli = async () => {
  try {
    const input = JSON.parse(await readStdin())
    const result = assessCodexToolUse(input)
    if (result.allowed) {
      return
    }
    process.stderr.write(`Chill Vibe 安全防护：${result.reason ?? '已阻止高风险操作。'}\n`)
    process.exitCode = 2
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Chill Vibe 安全防护无法解析命令，已失败关闭：${message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCli()
}
