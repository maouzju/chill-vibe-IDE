import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Release safety is deliberately implemented in plain Node here.  The release
 * workflow runs this file before installing dependencies, so importing a
 * TypeScript server module would make the guard depend on a loader that CI
 * does not have.
 */

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SCAN_BYTES = 16 * 1024 * 1024
const SYNTHETIC_USERS = new Set(['demo', 'tester', 'u'])
const SYNTHETIC_PROJECTS = new Set([
  'chill-vibe',
  'other-repo',
  'docs-site',
  'example-wiki',
  'notes',
  'notes.md',
])
// Keep the denylist itself out of the scanner's candidate matches.  The
// runtime joins are intentional: this source file is audited like every other
// changed file, while callers still get exact-name detection.
const EXTERNAL_PROJECT_NAMES = new Set([
  ['baz', 'tato'].join(''),
  ['maou', '-wiki'].join(''),
  ['chill', '-storm'].join(''),
  ['music', '_manager'].join(''),
  'yu' + 'ze',
])
const ALLOWED_SYNTHETIC_ARTIFACTS = new Set([
  'tests/fixtures/claude-unsolicited-real-wake.jsonl',
  'tests/fixtures/claude-unsolicited-failed-wake.jsonl',
])
const BLOCKED_ARTIFACT_SEGMENTS = [
  '.codex-artifacts',
  '.claude-artifacts',
  'release-scratch',
  '.tmp-release-',
  'raw-session',
  'session-capture',
]
const BLOCKED_ARTIFACT_EXTENSIONS = new Set([
  '.ndjson',
  '.har',
  '.trace',
  '.dmp',
])
const SCREENSHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function normalizeRelativePath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
}

function normalizeForCompare(value) {
  // Runs of backslashes collapse to one `/` so an escaped `C:\\Users\\...`
  // compares like its forward-slash spelling.
  return String(value ?? '').replace(/\\+/gu, '/').toLowerCase()
}

export function createReleaseSafetyFinding(pathName, category, line) {
  const finding = { category: String(category), path: normalizeRelativePath(pathName) }
  if (Number.isInteger(line) && line > 0) {
    finding.line = line
  }
  return finding
}

function lineNumberAt(text, index) {
  return String(text).slice(0, Math.max(0, index)).split('\n').length
}

function addFinding(findings, seen, pathName, category, line) {
  const finding = createReleaseSafetyFinding(pathName, category, line)
  const key = `${finding.category}\u0000${finding.path}\u0000${finding.line ?? ''}`
  if (!seen.has(key)) {
    seen.add(key)
    findings.push(finding)
  }
}

function isTestPath(pathName) {
  const normalized = normalizeRelativePath(pathName).toLowerCase()
  return normalized === 'tests' || normalized.startsWith('tests/')
}

const localPathExistsCache = new Map()
function defaultLocalPathExists(absolutePath) {
  // Only this machine can tell an invented fixture root from a real checkout.
  // CI (Linux) never has these Windows roots, so it falls back to the denylist.
  if (process.platform !== 'win32') return false
  const key = absolutePath.toLowerCase()
  if (!localPathExistsCache.has(key)) localPathExistsCache.set(key, fs.existsSync(absolutePath))
  return localPathExistsCache.get(key)
}

function currentUserName() {
  try {
    return os.userInfo().username.toLowerCase()
  } catch {
    return ''
  }
}

// 症状：2026-11-21 历史审计报 717 条，其中 708 条是测试里编的假根目录
// （D:/Git/<编的项目名>、C:/Users/<编的用户名>），每个测试作者都得去绕扫描器。
// 根因：历史审计没有"基线未变"兜底，而 11-20 起又能识别 \\ 转义写法，老测试一次性全红。
// 为什么这样判：编出来的名字在本机不存在就泄露不了任何东西；真实项目/用户目录
// 在本机一定存在，再加真名黑名单兜底 CI。只放宽 tests/，生产代码仍从严。
function isInventedFixtureRoot(name, absolutePath, options) {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) return false
  for (const denied of EXTERNAL_PROJECT_NAMES) {
    if (name.includes(denied.toLowerCase())) return false
  }
  const localPathExists = typeof options.localPathExists === 'function'
    ? options.localPathExists
    : defaultLocalPathExists
  return !localPathExists(absolutePath)
}

function isAllowedSyntheticPath(pathName, value, options = {}) {
  const normalizedPath = normalizeRelativePath(pathName).toLowerCase()
  const normalizedValue = normalizeForCompare(value)
  if (normalizedValue === 'd:/git/chill-vibe' || normalizedValue.startsWith('d:/git/chill-vibe/')) {
    return true
  }
  if (!isTestPath(normalizedPath)) {
    return false
  }
  for (const user of SYNTHETIC_USERS) {
    if (normalizedValue === `c:/users/${user}` || normalizedValue.startsWith(`c:/users/${user}/`)) {
      return true
    }
  }
  for (const project of SYNTHETIC_PROJECTS) {
    if (normalizedValue === `d:/git/${project}` || normalizedValue.startsWith(`d:/git/${project}/`)) {
      return true
    }
  }
  const fixtureUser = normalizedValue.match(/^c:\/users\/([^/]+)/u)?.[1]
  if (
    fixtureUser
    && fixtureUser !== currentUserName()
    && isInventedFixtureRoot(fixtureUser, `C:/Users/${fixtureUser}`, options)
  ) {
    return true
  }
  const fixtureProject = normalizedValue.match(/^d:\/git\/([^/]+)/u)?.[1]
  if (fixtureProject && isInventedFixtureRoot(fixtureProject, `D:/Git/${fixtureProject}`, options)) {
    return true
  }
  // Symptom: v0.20.8's new crash-recovery tests reported 9 `machine-path`
  // findings for invented workspace roots (`D:/<made-up-name>`), while the
  // identical long-standing fixture root in 8 baseline test files reported
  // clean.  Root cause: those older files were only spared by the
  // unchanged-baseline check, so the fixture convention was legal in existing
  // files and illegal in new ones — which pressures authors to rewrite correct
  // tests rather than the detector.  A single ASCII segment under a drive root
  // cannot name a real user directory: `C:/Users/...` and `D:/Git/<project>/...`
  // are both multi-segment and already classified above, and real Windows
  // folders here (`D:/<中文目录>`) are non-ASCII or nested.  Rejected "add each
  // new fixture root to SYNTHETIC_PROJECTS": that makes every new test edit this
  // scanner, and a scanner people routinely edit to pass stops being a gate.
  if (/^[a-z]:\/[a-z0-9][a-z0-9-]*$/u.test(normalizedValue)) {
    return true
  }
  return false
}

function isAllowedBearer(value, pathName) {
  const token = String(value).trim()
  if (/^0{16,}$/u.test(token)) {
    return true
  }
  // Short provider names are test wiring, not credentials.  Keep this
  // allowlist exact and scoped; a broad `sk-` exemption would hide a leak.
  return isTestPath(pathName) && new Set([
    'sk-test',
    'sk-codex',
    'sk-claude',
    'sk-old',
    'sk-new',
    'sk-existing',
    'sk-manual',
  ]).has(token)
}

function findMatches(text, regex) {
  const matches = []
  regex.lastIndex = 0
  for (const match of String(text).matchAll(regex)) {
    if (match.index == null) continue
    matches.push({ value: match[0], index: match.index, captures: match.slice(1) })
  }
  return matches
}

function valueIsInBaseline(value, baselineText) {
  if (baselineText == null || baselineText === '') return false
  return String(baselineText).includes(value)
}

function scanCredentialPatterns(pathName, text, findings, seen) {
  const patterns = [
    ['private-key', /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|PGP)\s+)?PRIVATE\s+KEY-----/gmu],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gmu],
    ['github-token', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gmu],
    ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/gmu],
    ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gmu],
    ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gmu],
    ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/gmu],
    ['pypi-token', /\bpypi-[A-Za-z0-9_-]{20,}\b/gmu],
    ['anthropic-token', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gmu],
    ['openai-token', /\bsk-proj-[A-Za-z0-9_-]{20,}\b/gmu],
    ['openai-token', /\bsk-(?!ant-)[A-Za-z0-9_-]{32,}\b/gmu],
    ['google-token', /\bAIza[A-Za-z0-9_-]{30,}\b/gmu],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gmu],
  ]
  const specificTokenSpans = []
  for (const [category, regex] of patterns) {
    for (const match of findMatches(text, regex)) {
      addFinding(findings, seen, pathName, category, lineNumberAt(text, match.index))
      if (category !== 'private-key' && category !== 'jwt') {
        specificTokenSpans.push([match.index, match.index + match.value.length])
      }
    }
  }

  for (const match of findMatches(text, /\bBearer\s+([^\s"'<>]{20,})|\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{20,})/gimu)) {
    const value = match.value
    const token = match.captures?.[0] ?? match.captures?.[1] ?? ''
    const isAssignmentExpression = match.captures?.[1] != null
    if (isAssignmentExpression && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(token)) continue
    const tokenIndex = match.index + Math.max(0, value.indexOf(token))
    const overlapsSpecific = specificTokenSpans.some(
      ([start, end]) => tokenIndex < end && tokenIndex + token.length > start,
    )
    if (overlapsSpecific || !token || isAllowedBearer(token, pathName)) continue
    // Do not treat template variables and conspicuous placeholders as secrets.
    if (/^(?:\$\{|<|YOUR_|CHANGE_ME|example|test(?:[-_]|$))/iu.test(token)) continue
    addFinding(findings, seen, pathName, 'bearer-token', lineNumberAt(text, match.index))
  }
}

function scanPathPatterns(pathName, text, baselineText, findings, seen, options = {}) {
  const candidates = []
  // `(?:\\\\|[\\/])`: JSON / JS string literals escape every backslash of a
  // Windows path (`C:\\Users\\...`); the 2026-11-20 review found those produced
  // zero candidates.
  const pathRegexes = [
    /\b[A-Za-z]:(?:\\\\|[\\/])[^\\/\s"'<>`]+(?:[\\/][^\s"'<>`]*)?/gimu,
    /\b(?:file:\/\/)?\/(?:home|Users)\/[^\s"'<>]+/gimu,
  ]
  for (const regex of pathRegexes) candidates.push(...findMatches(text, regex))
  for (const match of candidates) {
    const value = match.value.replace(/[),.;`]+$/u, '')
    // A source regex/template such as `C:/Users/${name}` is a detector
    // implementation, not a leaked machine path.  Only inspect concrete path
    // segments; this also keeps this file from reporting its own patterns.
    // Documentation often uses `C:\Users\...` / `D:\Git\...` as a
    // deliberately non-concrete shape. Treat those ellipsis-only examples
    // like the existing `${name}` templates; a real username/project still
    // goes through the fail-closed path checks below.
    if (
      /[\[\]{}$*?+|]/u.test(value) ||
      /(?:^|[\\/])\.\.\.(?:$|[\\/])/u.test(value) ||
      /<[^>]+>/u.test(value) ||
      /[\\/]$/u.test(value) ||
      /\.join\($/u.test(value)
    ) continue
    if (isAllowedSyntheticPath(pathName, value, options) || valueIsInBaseline(value, baselineText)) continue
    const normalized = normalizeForCompare(value)
    if (/^[a-z]:[\\/]users[\\/]/u.test(normalized) || /\/(?:home|users)\//u.test(normalized)) {
      addFinding(findings, seen, pathName, 'personal-path', lineNumberAt(text, match.index))
      continue
    }
    const project = normalized.match(/^d:\/git\/([^/]+)/u)?.[1]
    if (project && !SYNTHETIC_PROJECTS.has(project) && !valueIsInBaseline(value, baselineText)) {
      addFinding(findings, seen, pathName, 'external-project-path', lineNumberAt(text, match.index))
      continue
    }
    addFinding(findings, seen, pathName, 'machine-path', lineNumberAt(text, match.index))
  }

  const lower = String(text).toLowerCase()
  for (const name of EXTERNAL_PROJECT_NAMES) {
    let from = 0
    while (true) {
      const index = lower.indexOf(name.toLowerCase(), from)
      if (index < 0) break
      if (!valueIsInBaseline(name, baselineText)) {
        addFinding(findings, seen, pathName, 'external-project-path', lineNumberAt(text, index))
      }
      from = index + name.length
    }
  }
}

/**
 * Scan text and return safe findings.  `baselineText` is used only to avoid
 * reporting an unchanged local/external path; credentials are always rejected
 * when they are present in the inspected candidate text.
 */
export function auditReleaseText(pathName, text, options = {}) {
  const findings = []
  const seen = new Set()
  const content = String(text ?? '')
  const baselineText = options.baselineText == null ? '' : String(options.baselineText)
  scanCredentialPatterns(pathName, content, findings, seen)
  scanPathPatterns(pathName, content, baselineText, findings, seen, options)
  return findings.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path)
    if (pathOrder !== 0) return pathOrder
    const lineOrder = (left.line ?? 0) - (right.line ?? 0)
    return lineOrder || left.category.localeCompare(right.category)
  })
}

function isAllowedArtifactPath(pathName, content = '') {
  const normalized = normalizeRelativePath(pathName).toLowerCase()
  if (ALLOWED_SYNTHETIC_ARTIFACTS.has(normalized)) {
    return /origin[\s\S]{0,100}kind[\s\S]{0,40}test-fixture|apiKeySource[\s\S]{0,40}none/iu.test(content)
  }
  return false
}

export function auditReleasePath(pathName, text, options = {}) {
  const normalized = normalizeRelativePath(pathName)
  const findings = auditReleaseText(normalized, text, options)
  const lower = normalized.toLowerCase()
  const blockedSegment = BLOCKED_ARTIFACT_SEGMENTS.some((segment) => lower.includes(segment))
  const blockedExtension = [...BLOCKED_ARTIFACT_EXTENSIONS].some((extension) => lower.endsWith(extension))
  const blockedLog = /(?:^|\/)(?:[^/]+\.(?:log|jsonl))(?:$|\/)/iu.test(lower)
  const isUntracked = options.untracked === true
  const blockedScreenshot = isUntracked && [...SCREENSHOT_EXTENSIONS].some((extension) => lower.endsWith(extension))
  if ((blockedSegment || blockedExtension || blockedLog || blockedScreenshot) && !isAllowedArtifactPath(normalized, text)) {
    const seen = new Set(findings.map((finding) => `${finding.category}\u0000${finding.path}\u0000${finding.line ?? ''}`))
    addFinding(findings, seen, normalized, 'debug-artifact')
  }
  return findings
}

function stripAnsi(value) {
  return String(value).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu, '')
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value ?? '')).filter((value) => value.length >= 8))]
    .sort((left, right) => right.length - left.length)
}

function credentialRedactionRegex() {
  return [
    /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|PGP)\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:(?:RSA|EC|DSA|OPENSSH|PGP)\s+)?PRIVATE\s+KEY-----/gimu,
    /\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|npm_|pypi-|sk-proj-|sk-ant-|sk-|AIza)[A-Za-z0-9_-]{12,}\b/gmu,
    /\bBearer\s+(?!0{16,}\b)(?!\$\{)(?!<)[A-Za-z0-9._~+/=-]{20,}/gimu,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gmu,
  ]
}

function pathRedactionRegexes() {
  return [
    /\b[A-Za-z]:[\\/]Users[\\/][^\s"'<>]+/gimu,
    /\b(?:file:\/\/)?\/(?:home|Users)\/[^\s"'<>]+/gimu,
    /\b[A-Za-z]:[\\/](?!(?:Windows|Program Files(?: \(x86\))?|ProgramData)[\\/])[^\s"'<>]+/gimu,
  ]
}

function repoRootRedactionValues(options) {
  const repoRoot = String(options.repoRoot ?? '').trim()
  if (!repoRoot) return []
  const variants = [repoRoot, repoRoot.replaceAll('\\', '/'), repoRoot.replaceAll('/', '\\')]
  return uniqueStrings(variants)
}

function sensitiveRedactionValues(options) {
  const sensitiveValues = [
    ...(Array.isArray(options.sensitiveValues) ? options.sensitiveValues : []),
    ...Object.entries(options.env ?? {}).filter(([key]) => /(?:TOKEN|KEY|SECRET|PASSWORD)/iu.test(key)).map(([, value]) => value).filter((value) => value != null),
  ]
  return uniqueStrings(sensitiveValues)
    .filter((value) => !/^(?:sk-(?:test|codex|claude|old|new|existing|manual)|0+)$/iu.test(value))
}

/** Redact untrusted command output without touching email addresses. */
export function redactReleaseLogText(text, options = {}) {
  let output = stripAnsi(text)
  for (const regex of credentialRedactionRegex()) {
    output = output.replace(regex, '<redacted-credential>')
  }

  for (const variant of repoRootRedactionValues(options)) {
    output = output.replaceAll(variant, '<redacted-path>')
    output = output.replaceAll(`file://${variant}`, '<redacted-path>')
  }

  for (const regex of pathRedactionRegexes()) {
    output = output.replace(regex, '<redacted-path>')
  }

  for (const value of sensitiveRedactionValues(options)) {
    output = output.replaceAll(value, '<redacted-credential>')
  }
  return output
}

/**
 * Move a streaming cut back so it never lands inside anything the redactor
 * would replace.  Spans are found on the whole pending buffer (emit + tail),
 * so a value straddling the cut is seen as one piece.
 */
function redactionSafeCut(text, cut, options) {
  const spans = []
  for (const regex of [...credentialRedactionRegex(), ...pathRedactionRegexes()]) {
    for (const match of findMatches(text, regex)) {
      spans.push([match.index, match.index + match.value.length])
    }
  }
  // A private-key block whose END line has not arrived yet must not be split.
  const openKey = /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|PGP)\s+)?PRIVATE\s+KEY-----(?![\s\S]*-----END\s)/imu.exec(text)
  if (openKey) spans.push([openKey.index, text.length])
  for (const value of [...repoRootRedactionValues(options), ...sensitiveRedactionValues(options)]) {
    for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + 1)) {
      spans.push([index, index + value.length])
    }
  }
  let safeCut = cut
  let moved = true
  while (moved) {
    moved = false
    for (const [start, end] of spans) {
      if (start < safeCut && safeCut < end) {
        safeCut = start
        moved = true
      }
    }
  }
  return safeCut
}

export function createReleaseLogRedactor(options = {}) {
  let pending = ''
  return {
    push(chunk) {
      pending += String(chunk ?? '')
      // Keep a tail so a token split across child-process chunks is still
      // recognized on the next push.  Credentials are much shorter than this.
      // Symptom (2026-11-20 review): cutting at a fixed `length - 512` could
      // split `sk-ant-AB|…` itself, and neither half matched a redaction rule.
      // The cut now backs off to the start of any match spanning it; rejected
      // "cut at the last whitespace": it splits `Bearer <token>` the same way.
      const safeLength = redactionSafeCut(pending, Math.max(0, pending.length - 512), options)
      const emit = pending.slice(0, safeLength)
      pending = pending.slice(safeLength)
      return redactReleaseLogText(emit, options)
    },
    flush() {
      const emit = redactReleaseLogText(pending, options)
      pending = ''
      return emit
    },
  }
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status ?? 1})`)
  }
  return String(result.stdout ?? '')
}

function parseNulList(value) {
  return String(value).split('\0').filter(Boolean)
}

function listChangedPaths(repoRoot, baseRef) {
  const resolvedBase = /(?:\^|~)\d*$/u.test(baseRef) ? baseRef : `${baseRef}^{commit}`
  return [...new Set([
    ...parseNulList(runGit(repoRoot, ['diff', '--name-only', '-z', '--no-ext-diff', resolvedBase, '--'])),
    ...parseNulList(runGit(repoRoot, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', resolvedBase, '--'])),
    ...parseNulList(runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])),
  ])].sort()
}

function readBaselineFile(repoRoot, baseRef, relativePath) {
  const result = spawnSync('git', ['show', `${baseRef}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_SCAN_BYTES + 1,
    windowsHide: true,
  })
  return result.status === 0 ? String(result.stdout ?? '') : ''
}

async function scanCandidatePath(repoRoot, baseRef, relativePath) {
  const absolutePath = path.resolve(repoRoot, relativePath)
  const pathParts = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  let walkedPath = repoRoot
  for (const part of pathParts) {
    walkedPath = path.join(walkedPath, part)
    try {
      const partStats = await lstat(walkedPath)
      if (partStats.isSymbolicLink()) {
        return [createReleaseSafetyFinding(relativePath, 'unsafe-path')]
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      break
    }
  }
  // A missing worktree copy must still fall through to the index scan below:
  // `git add leak.env && rm leak.env` used to return [] here and pass the
  // audit with the credential staged (2026-11-20 review).
  let stats = null
  try {
    stats = await lstat(absolutePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const baseline = readBaselineFile(repoRoot, baseRef, relativePath)
  const findings = []
  const scanContent = (content, options = {}) => {
    findings.push(...auditReleasePath(relativePath, content, { baselineText: baseline, ...options }))
  }
  if (stats?.isSymbolicLink()) {
    findings.push(createReleaseSafetyFinding(relativePath, 'unsafe-path'))
  } else if (stats?.isFile()) {
    if (stats.size > MAX_SCAN_BYTES) {
      findings.push(createReleaseSafetyFinding(relativePath, 'unscannable-file'))
    } else {
      const buffer = await readFile(absolutePath)
      // Latin-1 preserves ASCII credential markers in binary blobs without
      // attempting to execute or follow the file.  Normal UTF-8 text remains
      // the common path; binary snapshots simply get a conservative scan.
      scanContent(buffer.includes(0) ? buffer.toString('latin1') : buffer.toString('utf8'), {
        untracked: baseline === '' && !isTrackedCandidate(repoRoot, relativePath),
      })
    }
  }

  // A staged-only edit can differ from the working file.  Scan the index blob
  // as well, so `git add` cannot hide a credential from the release audit.
  const indexContent = readIndexFile(repoRoot, relativePath)
  if (indexContent != null && indexContent !== '') {
    scanContent(indexContent, { untracked: false })
  }
  return findings
}

function isTrackedCandidate(repoRoot, relativePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0
}

function readIndexFile(repoRoot, relativePath) {
  const result = spawnSync('git', ['show', `:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_SCAN_BYTES + 1,
    windowsHide: true,
  })
  if (result.status !== 0) return null
  return String(result.stdout ?? '')
}

/** Enumerate and audit the candidate working tree relative to a Git base. */
export async function auditReleaseCandidate(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? scriptRoot)
  const baseRef = String(options.base ?? 'origin/main')
  // `^{commit}` makes an annotated tag resolve to its commit and fails closed
  // for a typo instead of silently comparing against an empty tree.
  const verificationRef = /(?:\^|~)\d*$/u.test(baseRef) ? baseRef : `${baseRef}^{commit}`
  runGit(repoRoot, ['rev-parse', '--verify', verificationRef])
  const paths = listChangedPaths(repoRoot, baseRef)
  const findings = []
  for (const relativePath of paths) {
    findings.push(...await scanCandidatePath(repoRoot, baseRef, relativePath))
  }
  for (const notesPath of options.notesFiles ?? []) {
    const absolute = path.isAbsolute(notesPath) ? notesPath : path.resolve(repoRoot, notesPath)
    const content = await readFile(absolute, 'utf8')
    findings.push(...auditReleaseText(normalizeRelativePath(notesPath), content))
  }
  const unique = new Map()
  for (const finding of findings) {
    const key = JSON.stringify(finding)
    unique.set(key, finding)
  }
  return [...unique.values()].sort((left, right) =>
    `${left.path}:${left.line ?? 0}:${left.category}`.localeCompare(`${right.path}:${right.line ?? 0}:${right.category}`),
  )
}

function printUsage() {
  console.log('Usage: node scripts/audit-release-safety.mjs [--base <ref>] [--root <dir>] [--notes-file <file>] [--json]')
}

async function main(argv) {
  const options = { base: 'origin/main', repoRoot: scriptRoot, json: false, notesFiles: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      printUsage()
      return 0
    }
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--base' || arg === '--root' || arg === '--notes-file') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--base') options.base = value
      else if (arg === '--root') options.repoRoot = path.resolve(value)
      else options.notesFiles.push(path.resolve(options.repoRoot, value))
      continue
    }
    if (arg.startsWith('--base=')) options.base = arg.slice(7)
    else if (arg.startsWith('--root=')) options.repoRoot = path.resolve(arg.slice(7))
    else if (arg.startsWith('--notes-file=')) options.notesFiles.push(path.resolve(options.repoRoot, arg.slice(13)))
    else throw new Error(`Unknown argument: ${arg}`)
  }

  const findings = await auditReleaseCandidate(options)
  if (options.json) {
    console.log(JSON.stringify(findings, null, 2))
  } else if (findings.length === 0) {
    console.log('[release-audit] no sensitive content found')
  } else {
    for (const finding of findings) {
      const location = finding.line ? `${finding.path}:${finding.line}` : finding.path
      console.error(`[release-audit] ${finding.category} at ${location}`)
    }
  }
  return findings.length === 0 ? 0 : 1
}

const directPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const modulePath = path.resolve(fileURLToPath(import.meta.url))
if (directPath && (process.platform === 'win32' ? directPath.toLowerCase() === modulePath.toLowerCase() : directPath === modulePath)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    // Keep failures useful without echoing Git's potentially sensitive raw
    // stderr (which can contain a path or a command argument).
    console.error(`[release-audit] failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
