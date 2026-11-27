import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  detectAttackPatterns,
  formatAttackPatternReason,
} from './attack-pattern-rules.js'
import {
  evaluateMemoryBudget,
  isHeavyShellCommand,
  probeSystemMemory,
  readMemoryBudgetFromEnv,
} from './memory-budget-guard.js'

// Gemini CLI 的工具名：run_shell_command / write_file / replace（2026-11-20 补，否则 Gemini 卡整个绕过防护）。
// Claude Code 在 Windows 上另有原生 PowerShell 工具（CLI 2.1.322 默认启用），2026-11-27 前钩子 matcher
// 与这里都不认它，Claude 卡改用 PowerShell 工具就整个绕过防护（与上面 Gemini 同根因）。
const shellToolPattern = /^(?:Bash|PowerShell|shell|shell_command|exec_command|write_stdin|run_shell_command)$/i
const directWriteToolPattern = /^(?:apply_patch|Edit|Write|NotebookEdit|write_file|replace)$/i
const pythonRmtreePattern = /\bshutil\.rmtree\s*\(/i
const nodeRecursiveDeletePattern = /\b(?:fs\.)?(?:rm|rmSync)\s*\([^)]*recursive\s*:\s*true/is
// 症状：PowerShell 的 `[IO.Directory]::Delete(<目录>, $true)` 被判为非破坏性放行（2026-11-20 审查）。
// 根因：旧正则只认 C# 的 `Directory.Delete(x, true)`，PowerShell 静态调用用 `]::` 且布尔是 `$true`。
//   DirectoryInfo 的 `.Delete($true)` 目标是运行时对象，执行前无法确认，一律按无法确认目标拦截。
const dotnetRecursiveDeletePattern = /\bDirectory\]?(?:\.|::)Delete\s*\([^,]+,\s*\$?true\s*\)/i
// PowerShell 方法名不分大小写但布尔必须写 `$true`；C# 写 `.Delete(true)` 区分大小写——
// 不放宽成 /i 的 `true`，否则 JS 的 `set.delete(true)` 也会被误拦。
const dotnetDirectoryInfoRecursiveDeletePattern = {
  test: (command) =>
    /\.delete\s*\(\s*\$true\s*\)/i.test(command) || /\.Delete\s*\(\s*true\s*\)/.test(command),
}
const powershellHomeAssignmentPattern = /\$home\s*=/i
const automaticTemporaryCleanupPattern = /\b(?:tempfile\.)?TemporaryDirectory\s*\(/i
const bindMountPattern = /\b(?:mount_bind\s*\(|mount\s+(?:--bind\b|-o\s+bind\b)|bind[-_ ]mount)\b/i
const unresolvedVariablePattern = /(?:\$\(|\$\{[^}\r\n]+\}|\$(?:env:)?[A-Za-z_][\w:]*|%[^%\r\n]+%|@\s*\()/i
const runtimeExpansionPattern = /[`]|^~[^\\/]/
const wildcardPattern = /[*?\[\]]/
const shellWriteCommandPattern = /(?:^|[;&|]\s*)(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|touch|mkdir|md|cp|mv|copy|move|install|tee|del|rmdir)\b|>{1,2}\s*/i

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

// 症状：`Remove-Item -LiteralPath <工作区>\tmp,<项目外目录> -Recurse` 被判为工作区内删除放行，
//   PowerShell 实际把逗号列表当 string[]，两个路径都删（2026-11-20 审查）。
// 根因：旧 tokenize 只按空白切词，逗号列表被当成一个路径，pathContains 算出的相对路径
//   逗号后那一截不是绝对路径于是判为工作区内。这里把引号外的逗号当数组分隔符，
//   一个参数的每个值都要单独过检查；不要改回「一出现逗号就整体当一个字符串」。
const argumentTokenPattern = /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|,|[^\s,]+/g

const parseArgumentTokens = (value) => {
  const tokens = []
  for (const match of value.matchAll(argumentTokenPattern)) {
    const raw = match[0]
    if (raw === ',') {
      tokens.push({ comma: true, start: match.index })
      continue
    }
    const quoted =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    const text = quoted
      ? raw.startsWith("'")
        ? raw.slice(1, -1).replace(/''/g, "'")
        : raw.slice(1, -1)
      : raw.replace(/^['"]+|['"]+$/g, '')
    tokens.push({ comma: false, quoted, text, start: match.index })
  }
  return tokens
}

// 把 token 合成 PowerShell 风格的参数组：逗号相连的值属于同一组；`-Name:value` 拆成参数 + 值。
const parseArgumentGroups = (value) => {
  const groups = []
  let joinNext = false
  for (const token of parseArgumentTokens(value)) {
    if (token.comma) {
      joinNext = groups.length > 0 && !groups.at(-1).parameter
      continue
    }
    if (!token.text && !token.quoted) {
      continue
    }
    if (!token.quoted && /^-/.test(token.text) && !joinNext) {
      const colon = token.text.match(/^(-[^:]+):(.+)$/)
      if (colon) {
        groups.push({ parameter: true, values: [colon[1]], start: token.start })
        groups.push({ parameter: false, values: [colon[2]], start: token.start })
      } else {
        groups.push({ parameter: true, values: [token.text], start: token.start })
      }
      joinNext = false
      continue
    }
    if (joinNext) {
      groups.at(-1).values.push(token.text)
    } else {
      groups.push({ parameter: false, values: [token.text], start: token.start })
    }
    joinNext = false
  }
  return groups
}

const findNamedArgumentValues = (groups, names) => {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()))
  for (let index = 0; index < groups.length - 1; index += 1) {
    if (
      groups[index].parameter &&
      normalizedNames.has(groups[index].values[0].toLowerCase()) &&
      !groups[index + 1].parameter
    ) {
      return groups[index + 1].values
    }
  }
  return null
}

const powershellPathParameterNames = ['-LiteralPath', '-Path', '-PSPath', '-LP']

const extractRmTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)rm\s+([^\r\n;&|]+)/gi
  for (const match of command.matchAll(pattern)) {
    for (const group of parseArgumentGroups(match[1])) {
      if (!group.parameter) {
        targets.push(...group.values)
      }
    }
  }
  return targets
}

const extractPowerShellTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|{}]\s*)(?:Remove-Item|ri)\s+([^;\r\n}]+)/gi
  for (const match of command.matchAll(pattern)) {
    const groups = parseArgumentGroups(match[1])
    const explicit = findNamedArgumentValues(groups, powershellPathParameterNames)
    if (explicit) {
      targets.push(...explicit)
      continue
    }

    const positional = groups.find((group) => !group.parameter)
    if (positional) {
      targets.push(...positional.values)
    }
  }
  return targets
}

const extractCmdTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)(?:rmdir|rd|del|erase)\s+([^\r\n;&|]+)/gi
  for (const match of command.matchAll(pattern)) {
    for (const group of parseArgumentGroups(match[1])) {
      if (!group.parameter) {
        targets.push(...group.values.filter((value) => !/^\/[a-z]+$/i.test(value)))
      }
    }
  }
  return targets
}

const extractFunctionTargets = (command) => {
  const targets = []
  const patterns = [
    /shutil\.rmtree\s*\(\s*([^,)]+)/gi,
    /(?:fs\.)?(?:rm|rmSync)\s*\(\s*([^,)]+)/gi,
    /\bDirectory\]?(?:\.|::)Delete\s*\(\s*([^,)]+)/gi,
  ]

  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      targets.push(stripOuterQuotes(match[1]))
    }
  }
  return targets
}

const extractRedirectionTargets = (command) => {
  const targets = []
  const pattern = />{1,2}\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s;&|]+)/g
  for (const match of command.matchAll(pattern)) {
    if (match[1]) {
      targets.push(stripOuterQuotes(match[1]))
    }
  }
  return targets
}

const extractPowerShellWriteTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|Rename-Item)\s+([^\r\n;&|]+)/gi

  for (const match of command.matchAll(pattern)) {
    const operation = match[1].toLowerCase()
    const groups = parseArgumentGroups(match[2])
    const pathValues = findNamedArgumentValues(groups, [...powershellPathParameterNames, '-FilePath'])
    const destination = findNamedArgumentValues(groups, ['-Destination', '-NewName'])
    const positional = groups.filter((group) => !group.parameter).map((group) => group.values)

    if (operation === 'copy-item') {
      const target = destination ?? positional.at(-1)
      if (target) targets.push(...target)
      continue
    }

    if (operation === 'move-item' || operation === 'rename-item') {
      const source = pathValues ?? positional[0]
      const target = destination ?? positional.at(-1)
      if (source) targets.push(...source)
      if (target && target !== source) targets.push(...target)
      continue
    }

    const target = pathValues ?? positional[0]
    if (target) targets.push(...target)
  }

  return targets
}

const extractPosixAndCmdWriteTargets = (command) => {
  const targets = []
  const pattern = /(?:^|[;&|]\s*)(touch|mkdir|md|cp|mv|copy|move|install|tee)\s+([^\r\n;&|]+)/gi

  for (const match of command.matchAll(pattern)) {
    const operation = match[1].toLowerCase()
    const positional = tokenize(match[2]).filter((token) => !token.startsWith('-'))
    if (positional.length === 0) continue

    if (operation === 'cp' || operation === 'copy' || operation === 'install') {
      targets.push(positional.at(-1))
      continue
    }

    targets.push(...positional)
  }

  return targets
}

const extractDirectWriteTargets = (toolName, toolInput) => {
  const targets = []
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'notebookPath',
    'target_path',
    'targetPath',
  ]) {
    const value = toolInput?.[key]
    if (typeof value === 'string' && value.trim()) {
      targets.push(value.trim())
    }
  }

  if (/^apply_patch$/i.test(toolName)) {
    const patchText = typeof toolInput?.patch === 'string'
      ? toolInput.patch
      : typeof toolInput?.input === 'string'
        ? toolInput.input
        : ''
    // `*** Move to:` 是 Update 段的改名目标，内容会写到新路径，必须和 Add/Update 一样过边界检查（2026-11-20 审查）。
    const patchPathPattern = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to):\s*(.+)$/gm
    for (const match of patchText.matchAll(patchPathPattern)) {
      if (match[1]?.trim()) {
        targets.push(match[1].trim())
      }
    }
  }

  return targets
}

// 按子命令段提取写入目标；python/node/.NET 函数调用形式会被括号切段打散，由调用方对整条命令单独提取。
const extractSegmentWriteTargets = (segment) => [
  ...extractRedirectionTargets(segment),
  ...extractPowerShellWriteTargets(segment),
  ...extractPosixAndCmdWriteTargets(segment),
  ...extractRmTargets(segment),
  ...extractPowerShellTargets(segment),
  ...extractCmdTargets(segment),
]

// 症状：`cd <工作区>` 换行 `rm -rf ~`、`bash -lc "rm -rf ~"`、`sudo rm -rf ~`、`rm ~ -rf`、
//   `find ~ -exec rm -rf {} +` 全被判为非破坏性直接放行（2026-11-20 审查）。
// 根因：删除/写入/git 正则都锚在「整串开头或 ; & | 之后」且无 m 标志，换行、包壳、前缀命令、
//   参数后置都不认。这里先把命令切成子命令段（换行、; & | ( ) { } 都算分隔，不管引号——
//   多切只会多查），再剥掉 sudo/env/xargs 等前缀、展开 bash -c / cmd /c / powershell -Command /
//   -EncodedCommand / iex，逐段判定。不要改回「在整串上加 m 标志」：包壳和前缀仍会漏。
const lineContinuationPattern = /[\\`][ \t]*\r?\n/g
const commandSegmentSeparatorPattern = /[\r\n;&|(){}]+/
const maxCommandUnwrapDepth = 6

const prefixRunnerNames = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'nice', 'ionice', 'timeout', 'stdbuf', 'xargs',
  'exec', 'command', 'builtin', 'busybox', 'setsid', 'unbuffer', 'wsl',
  '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until',
])
const shellWrapperNames = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish'])
const powershellHostNames = new Set(['powershell', 'pwsh', 'powershell_ise'])
const evalCommandNames = new Set(['eval', 'iex', 'invoke-expression'])
const powershellDeleteNames = new Set(['remove-item', 'ri'])
const cmdDeleteNames = new Set(['rmdir', 'rd', 'del', 'erase'])
// 前缀命令（sudo 等）后面跳过选项和取值，找到第一个「我们关心的」命令名再从那里判定。
const interestingCommandNames = new Set([
  'sudo', 'doas', 'env', 'nohup', 'nice', 'ionice', 'timeout', 'stdbuf', 'xargs',
  'exec', 'builtin', 'busybox', 'setsid', 'unbuffer', 'wsl',
  ...shellWrapperNames,
  ...powershellHostNames,
  ...evalCommandNames,
  ...powershellDeleteNames,
  ...cmdDeleteNames,
  'rm', 'find', 'git', 'cmd',
  'set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item', 'rename-item',
  'touch', 'mkdir', 'md', 'cp', 'mv', 'copy', 'move', 'install', 'tee',
])

const commandNameOf = (value) =>
  value.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')

const recursiveFlagPattern = /^-[^\s]*r/i

const unwrapQuotedScript = (value) => {
  const trimmed = value.trim()
  const quoted = trimmed.match(/^(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')/)
  if (quoted) {
    const raw = quoted[0]
    return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.slice(1, -1)
  }
  return trimmed.replace(/^['"]/, '')
}

const decodePowerShellEncodedCommand = (value) => {
  if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64').toString('utf16le')
  return decoded.trim() ? decoded : null
}

// 症状：关掉项目外写入后，`git rev-parse HEAD 2>/dev/null`、`Get-Command node 2>$null`、
//   `npm test 2>&1` 全被当成项目外写入拦下（2026-11-20 审查）。
// 根因：所有 `>` 后面的词都被当写入目标；`2>&1` 还会被按 & 切段，剩个没目标的 `>` 被判「无法确定」。
//   这里只剥掉「不落盘」的重定向（空设备 / 合并流），必须带边界，`> /dev/nullx`、`2>$nullTarget`
//   仍按普通写入判定；不要改成「整条命令里出现 /dev/null 就放行」，那会连同真正的写入一起放走。
const discardRedirectionPattern =
  /(?:[0-9*&]?>{1,2}\s*(?:\/dev\/null|\$null|nul)(?=$|[\s;&|)}'"])|[0-9*]?>&[0-9])/gi

const splitCommandSegments = (command) => {
  const normalized = command
    .replace(/\$\{([A-Za-z_]\w*)\}/g, '$$$1')
    .replace(discardRedirectionPattern, ' ')
  const joined = normalized.replace(lineContinuationPattern, ' ')
  const variants = new Set([normalized.replace(lineContinuationPattern, '\n'), joined])
  if (joined.includes('`')) {
    variants.add(joined.replace(/`/g, ';'))
  }

  const segments = new Set()
  for (const variant of variants) {
    for (const segment of variant.split(commandSegmentSeparatorPattern)) {
      const trimmed = segment.trim()
      if (trimmed) {
        segments.add(trimmed)
      }
    }
  }
  return [...segments]
}

const createCommandAnalysis = () => ({ segments: [], deletions: [], blockReasons: [] })

const mergeCommandAnalysis = (target, source) => {
  target.segments.push(...source.segments)
  target.deletions.push(...source.deletions)
  target.blockReasons.push(...source.blockReasons)
}

const analyzeShellText = (text, depth = 0, analysis = createCommandAnalysis()) => {
  if (depth > maxCommandUnwrapDepth) {
    analysis.blockReasons.push('命令嵌套包装层数过多，无法安全确认实际执行内容。')
    return analysis
  }
  for (const segment of splitCommandSegments(text)) {
    analysis.segments.push(segment)
    analyzeCommandSegment(segment, depth, analysis)
  }
  return analysis
}

const analyzeCommandSegment = (segment, depth, analysis) => {
  if (depth > maxCommandUnwrapDepth) {
    analysis.blockReasons.push('命令嵌套包装层数过多，无法安全确认实际执行内容。')
    return
  }

  const tokens = parseArgumentTokens(segment).filter((token) => !token.comma)
  let index = 0
  while (index < tokens.length && !tokens[index].quoted && /^[A-Za-z_]\w*=/.test(tokens[index].text)) {
    index += 1
  }
  if (index >= tokens.length) {
    return
  }

  const restFrom = (position) => (position < tokens.length ? segment.slice(tokens[position].start) : '')
  const head = commandNameOf(tokens[index].text)
  analysis.segments.push(restFrom(index))

  if (prefixRunnerNames.has(head)) {
    const next = tokens.findIndex(
      (token, position) => position > index && interestingCommandNames.has(commandNameOf(token.text)),
    )
    if (next < 0) {
      return
    }
    const inner = createCommandAnalysis()
    analyzeCommandSegment(restFrom(next), depth + 1, inner)
    if (head === 'xargs') {
      // xargs 的删除目标来自标准输入，执行前无法确认。
      inner.deletions = inner.deletions.map(() => ({ targets: [] }))
    }
    mergeCommandAnalysis(analysis, inner)
    return
  }

  if (shellWrapperNames.has(head)) {
    let position = index + 1
    let hasCommandFlag = false
    while (position < tokens.length && !tokens[position].quoted && /^[-+]/.test(tokens[position].text)) {
      const flag = tokens[position].text
      if (/^[-+]o$/i.test(flag) || /^--(?:rcfile|init-file)$/i.test(flag)) {
        position += 2
        continue
      }
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(flag)) {
        hasCommandFlag = true
      }
      position += 1
    }
    if (hasCommandFlag && position < tokens.length) {
      analyzeShellText(unwrapQuotedScript(restFrom(position)), depth + 1, analysis)
    }
    return
  }

  if (head === 'cmd') {
    const position = tokens.findIndex((token, offset) => offset > index && /^\/[ck]$/i.test(token.text))
    if (position >= 0 && position + 1 < tokens.length) {
      analyzeShellText(unwrapQuotedScript(restFrom(position + 1)), depth + 1, analysis)
    }
    return
  }

  if (powershellHostNames.has(head)) {
    const flags = tokens.map((token) => (token.quoted ? '' : token.text.toLowerCase()))
    const encodedIndex = flags.findIndex(
      (flag, offset) =>
        offset > index && (flag === '-ec' || (flag.length >= 2 && '-encodedcommand'.startsWith(flag))),
    )
    if (encodedIndex >= 0) {
      const decoded = decodePowerShellEncodedCommand(tokens[encodedIndex + 1]?.text ?? '')
      if (decoded === null) {
        analysis.blockReasons.push('无法解码 PowerShell -EncodedCommand，无法安全确认实际执行内容。')
      } else {
        analyzeShellText(decoded, depth + 1, analysis)
      }
      return
    }
    const commandIndex = flags.findIndex(
      (flag, offset) => offset > index && flag.length >= 2 && '-command'.startsWith(flag),
    )
    if (commandIndex >= 0) {
      analyzeShellText(unwrapQuotedScript(restFrom(commandIndex + 1)), depth + 1, analysis)
      return
    }
    const scriptIndex = tokens.findIndex(
      (token, offset) => offset > index && (token.quoted || !token.text.startsWith('-')),
    )
    if (scriptIndex >= 0) {
      analyzeShellText(unwrapQuotedScript(restFrom(scriptIndex)), depth + 1, analysis)
    }
    return
  }

  if (evalCommandNames.has(head)) {
    const scriptIndex = tokens.findIndex(
      (token, offset) => offset > index && (token.quoted || !token.text.startsWith('-')),
    )
    if (scriptIndex >= 0) {
      analyzeShellText(unwrapQuotedScript(restFrom(scriptIndex)), depth + 1, analysis)
    }
    return
  }

  if (head === 'find') {
    const roots = []
    let position = index + 1
    while (position < tokens.length && (tokens[position].quoted || !/^[-!(]/.test(tokens[position].text))) {
      roots.push(tokens[position].text)
      position += 1
    }
    let destructive = false
    for (let offset = position; offset < tokens.length; offset += 1) {
      if (tokens[offset].quoted) continue
      const flag = tokens[offset].text.toLowerCase()
      if (flag === '-delete') {
        destructive = true
      }
      if (/^-(?:exec|execdir|ok|okdir)$/.test(flag) && offset + 1 < tokens.length) {
        const inner = createCommandAnalysis()
        analyzeCommandSegment(restFrom(offset + 1), depth + 1, inner)
        analysis.segments.push(...inner.segments)
        analysis.blockReasons.push(...inner.blockReasons)
        if (inner.deletions.length > 0) {
          destructive = true
        }
      }
    }
    if (destructive) {
      // find 删除的是起点目录下的内容，按起点目录判定；未写起点时默认是相对的 `.`。
      analysis.deletions.push({ targets: roots.length > 0 ? roots : ['.'] })
    }
    return
  }

  const groups = parseArgumentGroups(restFrom(index + 1))
  const parameters = groups.filter((group) => group.parameter).map((group) => group.values[0])
  const values = groups.filter((group) => !group.parameter).flatMap((group) => group.values)

  if (head === 'rm') {
    if (parameters.some((flag) => recursiveFlagPattern.test(flag))) {
      analysis.deletions.push({
        targets: findNamedArgumentValues(groups, powershellPathParameterNames) ?? values,
      })
    }
    return
  }

  if (powershellDeleteNames.has(head)) {
    const explicit = findNamedArgumentValues(groups, powershellPathParameterNames)
    const positional = groups.find((group) => !group.parameter)
    analysis.deletions.push({ targets: explicit ?? positional?.values ?? [] })
    return
  }

  if (cmdDeleteNames.has(head)) {
    const recursive =
      values.some((value) => /^\/s$/i.test(value)) ||
      parameters.some((flag) => recursiveFlagPattern.test(flag))
    if (recursive) {
      analysis.deletions.push({
        targets:
          findNamedArgumentValues(groups, powershellPathParameterNames) ??
          values.filter((value) => !/^\/[a-z]+$/i.test(value)),
      })
    }
  }
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

const resolveBooleanSetting = (explicitValue, environmentValue, fallback) => {
  if (typeof explicitValue === 'boolean') {
    return explicitValue
  }
  if (environmentValue === '1') {
    return true
  }
  if (environmentValue === '0') {
    return false
  }
  return fallback
}

const createAssessmentContext = (input, options) => ({
  platform: options.platform ?? process.platform,
  workspaceRoot:
    options.workspaceRoot ??
    process.env.CHILL_VIBE_PROTECTED_WORKSPACE ??
    (typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd()),
  protectedHome: options.protectedHome ?? process.env.CHILL_VIBE_PROTECTED_HOME ?? '',
  codexHome: options.codexHome ?? process.env.CHILL_VIBE_PROTECTED_CODEX_HOME ?? '',
  appDataDir: options.appDataDir ?? process.env.CHILL_VIBE_PROTECTED_APP_DATA ?? '',
  mountPoints: options.mountPoints ?? readLinuxMountPoints(options.platform ?? process.platform),
})

const assessWorkspaceWriteTarget = (rawTarget, context) => {
  const pathApi = context.platform === 'win32' ? path.win32 : path.posix
  const stripped = stripOuterQuotes(rawTarget)
  const expanded = expandKnownHomeVariables(stripped, context.protectedHome)

  if (!expanded) {
    return '项目写入目标为空，无法安全确认范围。'
  }
  if (unresolvedVariablePattern.test(expanded) || runtimeExpansionPattern.test(expanded)) {
    return `项目写入目标包含未解析或运行时展开表达式：${stripped}`
  }
  if (wildcardPattern.test(expanded)) {
    return `项目写入目标包含通配符，无法安全确认最终范围：${stripped}`
  }

  const workspaceRoot = resolveExistingPath(
    pathApi.resolve(context.workspaceRoot),
    pathApi,
  )
  const lexicalTarget = pathApi.isAbsolute(expanded)
    ? pathApi.normalize(expanded)
    : pathApi.resolve(context.workspaceRoot, expanded)
  const candidate = resolveExistingPath(lexicalTarget, pathApi)

  if (!pathContains(workspaceRoot, candidate, pathApi)) {
    return `不允许修改当前项目文件夹之外的路径：${candidate}`
  }

  return null
}

const assessWorkspaceWriteTargets = (targets, context) => {
  for (const target of targets) {
    const reason = assessWorkspaceWriteTarget(target, context)
    if (reason) {
      return reason
    }
  }
  return null
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
  const destructiveCommandProtectionEnabled = resolveBooleanSetting(
    options.destructiveCommandProtectionEnabled,
    process.env.CHILL_VIBE_DESTRUCTIVE_COMMAND_PROTECTION_ENABLED,
    true,
  )
  const outsideWorkspaceWriteEnabled = resolveBooleanSetting(
    options.outsideWorkspaceWriteEnabled,
    process.env.CHILL_VIBE_OUTSIDE_WORKSPACE_WRITE_ENABLED,
    true,
  )
  const context = createAssessmentContext(input, options)

  if (directWriteToolPattern.test(toolName)) {
    if (outsideWorkspaceWriteEnabled) {
      return { allowed: true }
    }

    const targets = extractDirectWriteTargets(toolName, input?.tool_input)
    if (targets.length === 0) {
      return {
        allowed: false,
        reason: `无法安全确定 ${toolName || '文件工具'} 的最终写入路径。`,
      }
    }

    const reason = assessWorkspaceWriteTargets(targets, context)
    return reason ? { allowed: false, reason } : { allowed: true }
  }

  if (!shellToolPattern.test(toolName)) {
    return { allowed: true }
  }

  const command = normalizeCommand(input?.tool_input?.command)
  if (!command) {
    return { allowed: true }
  }

  const analysis = analyzeShellText(command)
  const segments = [...new Set(analysis.segments)]

  if (!outsideWorkspaceWriteEnabled) {
    for (const segment of segments) {
      const writeTargets = extractSegmentWriteTargets(segment)
      if (writeTargets.length === 0 && shellWriteCommandPattern.test(segment)) {
        return {
          allowed: false,
          reason: '检测到文件写入命令，但无法安全确定最终目标是否位于当前项目内。',
        }
      }
      const writeReason = assessWorkspaceWriteTargets(writeTargets, context)
      if (writeReason) {
        return { allowed: false, reason: writeReason }
      }
    }
    const functionWriteReason = assessWorkspaceWriteTargets(extractFunctionTargets(command), context)
    if (functionWriteReason) {
      return { allowed: false, reason: functionWriteReason }
    }
  }

  if (!destructiveCommandProtectionEnabled) {
    return { allowed: true }
  }

  for (const segment of segments) {
    const gitReason = assessGitCommand(segment)
    if (gitReason) {
      return { allowed: false, reason: gitReason }
    }
  }

  if (analysis.blockReasons.length > 0) {
    return { allowed: false, reason: analysis.blockReasons[0] }
  }

  if (automaticTemporaryCleanupPattern.test(command) && bindMountPattern.test(command)) {
    return {
      allowed: false,
      reason: '已阻止把绑定挂载放入会自动递归清理的 TemporaryDirectory；异常退出可能删除真实挂载内容。',
    }
  }

  const destructive =
    analysis.deletions.length > 0 ||
    pythonRmtreePattern.test(command) ||
    nodeRecursiveDeletePattern.test(command) ||
    dotnetRecursiveDeletePattern.test(command) ||
    dotnetDirectoryInfoRecursiveDeletePattern.test(command)

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
    /\bDirectory\]?(?:\.|::)Delete\s*\(\s*(?!["'])/i.test(command) ||
    dotnetDirectoryInfoRecursiveDeletePattern.test(command)
  ) {
    return {
      allowed: false,
      reason: '递归删除目标由运行时表达式计算，Chill Vibe 无法在执行前确认最终路径。',
    }
  }

  const targets = [
    ...analysis.deletions.flatMap((deletion) => deletion.targets),
    ...extractFunctionTargets(command),
  ]

  if (targets.length === 0 || analysis.deletions.some((deletion) => deletion.targets.length === 0)) {
    return {
      allowed: false,
      reason: '检测到递归删除，但无法安全确定最终目标。请改用明确的工作区子目录。',
    }
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

// 症状：攻形检测开着，`curl ... | bash` 仍然真的执行了，事后才停流。
// 根因：曾用退出码 3 来和常规高风险操作区分。但 Claude CLI 2.1.263 与 Codex CLI
//   0.153.4 的 PreToolUse 契约里只有 2 被当作阻断，二进制内原文：
//     Exit code 2 - show stderr to model and block tool call
//     Other exit codes - show stderr to user only but continue with tool call
//   于是 3 走 hook_non_blocking_error 分支，命令照跑 —— 安全开关制造了「已防护」
//   的错觉，比没有这个开关更危险。
// 为什么不能换写法：两类拦截都必须真阻断，所以退出码只能同为 2；渲染层需要的
//   「是攻形还是常规」改由 stderr 里的 ASCII 哨兵承担（见 attackPatternStderrMarker）。
//   CLI 不会把 hook 退出码结构化透传给渲染层，本来就只能读正文。
export const attackPatternExitCode = 2
export const destructiveCommandExitCode = 2

// 纯 ASCII 哨兵：中文说明经 cmd 包装层可能被 GBK 解码损坏，届时中文匹配会静默
// 失配、拦截功能无声消失。哨兵不含非 ASCII 字符，任何单字节编码下都原样存活。
export const attackPatternStderrMarker = 'CHILL_VIBE_ATTACK_PATTERN_BLOCK'

/** 子命令段（已展开 bash -c / powershell -Command / cmd /c 等包装层）里是否有会启动重任务的命令。 */
export const isHeavyShellToolCommand = (command) => {
  const normalized = normalizeCommand(command)
  if (!normalized) {
    return false
  }
  return isHeavyShellCommand([...new Set(analyzeShellText(normalized).segments)])
}

// AI 内存预算（docs/specs/agent-memory-budget）：只在攻形 / 危险命令 / 越界写都放行后才检查。
// 与上面的防护相反，这里一律 fail-open —— 探测超时、出错都放行，绝不能因为测内存把 agent 卡死。
const assessMemoryBudgetForToolUse = async (input, env, probeMemory) => {
  const budget = readMemoryBudgetFromEnv(env)
  if (!budget) {
    return null
  }
  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : ''
  if (!shellToolPattern.test(toolName) || /^write_stdin$/i.test(toolName)) {
    return null
  }
  try {
    if (!isHeavyShellToolCommand(input?.tool_input?.command)) {
      return null
    }
    const snapshot = await probeMemory({ budget })
    if (!snapshot) {
      return null
    }
    const verdict = evaluateMemoryBudget(snapshot, budget)
    return verdict.allowed ? null : { exitCode: memoryBudgetExitCode, reason: verdict.reason, raw: true }
  } catch {
    return null
  }
}

export const memoryBudgetExitCode = 2

export const evaluateToolUse = async (input, options = {}) => {
  const env = options.env ?? process.env
  const attackPatternsEnabled = resolveBooleanSetting(
    undefined,
    env.CHILL_VIBE_ATTACK_PATTERN_PROTECTION_ENABLED,
    false,
  )
  if (attackPatternsEnabled) {
    const matches = detectAttackPatterns(input)
    if (matches.length > 0) {
      return {
        exitCode: attackPatternExitCode,
        reason: [
          attackPatternStderrMarker,
          formatAttackPatternReason(matches),
          '',
          `命中内容：${matches[0].sample}`,
          '',
          '该形状在工作流中没有合法用途，已按疑似攻击处理。命令未执行，是否继续由你决定。',
        ].join(String.fromCharCode(10)),
      }
    }
  }

  const result = assessCodexToolUse(
    input,
    options.env
      ? {
          destructiveCommandProtectionEnabled: resolveBooleanSetting(
            undefined,
            env.CHILL_VIBE_DESTRUCTIVE_COMMAND_PROTECTION_ENABLED,
            true,
          ),
          outsideWorkspaceWriteEnabled: resolveBooleanSetting(
            undefined,
            env.CHILL_VIBE_OUTSIDE_WORKSPACE_WRITE_ENABLED,
            true,
          ),
        }
      : {},
  )
  if (!result.allowed) {
    return {
      exitCode: destructiveCommandExitCode,
      reason: result.reason ?? '已阻止高风险操作。',
    }
  }

  return assessMemoryBudgetForToolUse(input, env, options.probeMemory ?? probeSystemMemory)
}

const runCli = async () => {
  let input
  try {
    input = JSON.parse(await readStdin())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Chill Vibe 安全防护无法解析命令，已失败关闭：${message}
`)
    process.exitCode = destructiveCommandExitCode
    return
  }
  try {
    const verdict = await evaluateToolUse(input)
    if (!verdict) {
      return
    }
    process.stderr.write(verdict.raw ? `${verdict.reason}
` : `Chill Vibe 安全防护：${verdict.reason}
`)
    process.exitCode = verdict.exitCode
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Chill Vibe 安全防护无法解析命令，已失败关闭：${message}
`)
    process.exitCode = destructiveCommandExitCode
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCli()
}
