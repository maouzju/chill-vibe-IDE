import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditReleasePath } from './audit-release-safety.mjs'

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const HISTORY_CATEGORIES = new Set([
  'private-key',
  'github-token',
  'gitlab-token',
  'slack-token',
  'aws-access-key',
  'npm-token',
  'pypi-token',
  'anthropic-token',
  'openai-token',
  'google-token',
  'jwt',
  'bearer-token',
  'personal-path',
  'external-project-path',
  'debug-artifact',
])

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/')
}

function spawnGit(repoRoot, args, options = {}) {
  const timeoutMs = parseInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoRoot, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill()
      settled = true
      reject(new Error('git ' + args.join(' ') + ' timed out after ' + timeoutMs + 'ms'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error('git ' + args.join(' ') + ' failed (exit ' + (code ?? 1) + ')'))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

function parseObjectList(text) {
  const paths = new Map()
  const ids = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(/^([0-9a-f]{40})\s?(.*)$/u)
    if (!match) continue
    const [, oid, objectPath] = match
    if (!paths.has(oid)) {
      paths.set(oid, new Set())
      ids.push(oid)
    }
    if (objectPath) paths.get(oid).add(normalizePath(objectPath))
  }
  return { ids, paths }
}

async function collectReachableObjects(repoRoot, timeoutMs) {
  const result = await spawnGit(repoRoot, ['rev-list', '--objects', '--all'], { timeoutMs })
  return parseObjectList(result.stdout)
}

async function scanObjects(repoRoot, objectInfo, timeoutMs) {
  if (objectInfo.ids.length === 0) return []
  const child = spawn('git', ['cat-file', '--batch'], { cwd: repoRoot, windowsHide: true })
  const findings = []
  const seen = new Set()
  let buffer = Buffer.alloc(0)
  let settled = false
  let timer

  const finish = (error) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    if (error) child.kill()
  }

  try {
    timer = setTimeout(() => finish(new Error('git cat-file timed out after ' + timeoutMs + 'ms')), timeoutMs)
    child.stdin.end(objectInfo.ids.map((oid) => oid + '\n').join(''))
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const newline = buffer.indexOf(10)
        if (newline < 0) break
        const header = buffer.subarray(0, newline).toString('ascii')
        const parts = header.split(' ')
        if (parts.length < 3) {
          buffer = buffer.subarray(newline + 1)
          continue
        }
        const size = Number(parts[2])
        if (!Number.isFinite(size) || size < 0) throw new Error('invalid git cat-file size')
        if (buffer.length < newline + 1 + size + 1) break
        const body = buffer.subarray(newline + 1, newline + 1 + size)
        buffer = buffer.subarray(newline + 1 + size + 1)
        const oid = parts[0]
        if (parts[1] !== 'blob' || size > MAX_SCAN_BYTES) continue
        const text = body.includes(0) ? body.toString('latin1') : body.toString('utf8')
        const objectPaths = objectInfo.paths.get(oid) ?? new Set(['<unmapped-blob>'])
        for (const objectPath of objectPaths) {
          const objectFindings = auditReleasePath(objectPath, text, {
            baselineText: '',
            untracked: false,
          })
          for (const finding of objectFindings) {
            if (!HISTORY_CATEGORIES.has(finding.category)) continue
            const line = finding.line ?? 0
            const key = [oid, finding.category, finding.path, line].join('\0')
            if (seen.has(key)) continue
            seen.add(key)
            findings.push({ ...finding, oid })
          }
        }
      }
    }
    const [code] = await once(child, 'close')
    if (code !== 0) throw new Error('git cat-file failed (exit ' + (code ?? 1) + ')')
    finish()
    return findings
  } catch (error) {
    finish(error)
    throw error
  }
}

async function locateObject(repoRoot, oid, timeoutMs, cache) {
  if (cache.has(oid)) return cache.get(oid)
  const commitsResult = await spawnGit(
    repoRoot,
    ['log', '--all', '--find-object=' + oid, '--format=%H', '--no-show-signature'],
    { timeoutMs },
  )
  const commits = [...new Set(commitsResult.stdout.split(/\r?\n/).filter((value) => /^[0-9a-f]{40}$/u.test(value)))]
  const refs = new Set()
  for (const commit of commits.slice(0, 12)) {
    const refResult = await spawnGit(
      repoRoot,
      ['for-each-ref', '--contains', commit, '--format=%(refname)'],
      { timeoutMs },
    )
    for (const ref of refResult.stdout.split(/\r?\n/).map(normalizePath).filter(Boolean)) refs.add(ref)
  }
  const location = {
    commits: commits.slice(0, 12),
    refs: [...refs].sort(),
    refCount: refs.size,
  }
  cache.set(oid, location)
  return location
}

/*
 * Scan every blob reachable from local heads, remotes, tags, stash, and other
 * refs. Commit metadata is intentionally not read, so author/committer email
 * addresses remain outside the sensitive-content policy.
 */
export async function auditGitHistory(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? scriptRoot)
  const timeoutMs = parseInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS)
  const objectInfo = await collectReachableObjects(repoRoot, timeoutMs)
  const findings = await scanObjects(repoRoot, objectInfo, timeoutMs)
  const locationCache = new Map()
  const enriched = []
  for (const finding of findings) {
    const location = await locateObject(repoRoot, finding.oid, timeoutMs, locationCache)
    enriched.push({ ...finding, ...location })
  }
  enriched.sort((left, right) => {
    const leftKey = left.path + ':' + (left.line ?? 0) + ':' + left.category + ':' + left.oid
    const rightKey = right.path + ':' + (right.line ?? 0) + ':' + right.category + ':' + right.oid
    return leftKey.localeCompare(rightKey)
  })
  return {
    objectCount: objectInfo.ids.length,
    findingCount: enriched.length,
    findings: enriched,
  }
}

function printUsage() {
  console.log('Usage: node scripts/audit-git-history.mjs [--root <dir>] [--timeout-ms <n>] [--json]')
}

async function main(argv) {
  const options = { repoRoot: scriptRoot, timeoutMs: DEFAULT_TIMEOUT_MS, json: false }
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
    if (arg === '--root' || arg === '--timeout-ms') {
      const value = argv[index + 1]
      if (!value) throw new Error(arg + ' requires a value')
      index += 1
      if (arg === '--root') options.repoRoot = path.resolve(value)
      else options.timeoutMs = parseInteger(value, DEFAULT_TIMEOUT_MS)
      continue
    }
    if (arg.startsWith('--root=')) options.repoRoot = path.resolve(arg.slice(7))
    else if (arg.startsWith('--timeout-ms=')) options.timeoutMs = parseInteger(arg.slice(13), DEFAULT_TIMEOUT_MS)
    else throw new Error('Unknown argument: ' + arg)
  }
  const report = await auditGitHistory(options)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else if (report.findingCount === 0) {
    console.log('[history-audit] clean (' + report.objectCount + ' reachable objects)')
  } else {
    for (const finding of report.findings) {
      const location = finding.line ? finding.path + ':' + finding.line : finding.path
      const refText = finding.refs.length > 0 ? ' refs=' + finding.refs.slice(0, 8).join(',') : ''
      console.error('[history-audit] ' + finding.category + ' at ' + location + refText)
    }
  }
  return report.findingCount === 0 ? 0 : 1
}

const directPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const modulePath = path.resolve(fileURLToPath(import.meta.url))
if (directPath && (process.platform === 'win32' ? directPath.toLowerCase() === modulePath.toLowerCase() : directPath === modulePath)) {
  try {
    process.exitCode = await main(process.argv.slice(2))
  } catch (error) {
    console.error('[history-audit] failed: ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 2
  }
}
