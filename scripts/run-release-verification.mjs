import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const defaultProjectRoot = path.resolve(scriptDir, '..')
const STATE_VERSION = 1

const RELEASE_STAGES = [
  { id: 'legal', label: 'Legal inventory', command: 'pnpm', args: ['legal:check'] },
  { id: 'quality', label: 'Lint and type checks', command: 'pnpm', args: ['test:quality'] },
  { id: 'node', label: 'Node tests', command: 'pnpm', args: ['test'] },
  { id: 'playwright', label: 'Full Playwright', command: 'pnpm', args: ['test:playwright:full'] },
  { id: 'electron', label: 'Electron runtime', command: 'pnpm', args: ['test:electron'] },
  { id: 'build', label: 'Production build', command: 'pnpm', args: ['build'] },
]

function formatCommand(stage) {
  return [stage.command, ...stage.args].join(' ')
}

export function createStageInvocation(
  stage,
  platform = process.platform,
  commandProcessor = process.env.ComSpec,
) {
  if (platform === 'win32') {
    return {
      command: commandProcessor || 'cmd.exe',
      args: ['/d', '/s', '/c', formatCommand(stage)],
    }
  }

  return {
    command: stage.command,
    args: stage.args,
  }
}

export function createVerificationFingerprint({
  repoRoot,
  head,
  trackedDiff,
  untrackedEntries,
}) {
  const normalizedEntries = [...untrackedEntries]
    .map((entry) => ({
      path: String(entry.path).replaceAll('\\', '/'),
      hash: String(entry.hash),
      mode: String(entry.mode ?? 'file'),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))

  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        repoRoot: path.resolve(repoRoot).replaceAll('\\', '/').toLowerCase(),
        head,
        trackedDiff,
        untrackedEntries: normalizedEntries,
      }),
    )
    .digest('hex')
}

export function resolveReleaseStagePlan({
  stages,
  state,
  fingerprint,
  fresh,
  selectedStageIds,
}) {
  const selected = new Set(selectedStageIds)
  const runAll = selected.size === 0
  const reusableState = state?.fingerprint === fingerprint && !state?.invalidatedAt

  return stages.map((stage) => {
    const command = formatCommand(stage)
    const isSelected = runAll || selected.has(stage.id)

    if (!isSelected) {
      return { ...stage, commandText: command, action: 'not-selected' }
    }

    const evidence = reusableState ? state?.stages?.[stage.id] : undefined
    const canReuse =
      !fresh && evidence?.status === 'passed' && evidence?.command === command

    return {
      ...stage,
      commandText: command,
      action: canReuse ? 'reuse' : 'run',
    }
  })
}

export function resetInvalidatedVerificationState(state) {
  if (!state?.invalidatedAt) {
    return state
  }

  const {
    invalidatedAt: _invalidatedAt,
    invalidatedByFingerprint: _invalidatedByFingerprint,
    completedAt: _completedAt,
    updatedAt: _updatedAt,
    ...safeState
  } = state

  return {
    ...safeState,
    stages: {},
  }
}

function parseArgs(argv) {
  const options = {
    fresh: false,
    plan: false,
    selectedStageIds: [],
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--fresh') {
      options.fresh = true
      continue
    }

    if (arg === '--plan') {
      options.plan = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (arg === '--stage') {
      options.selectedStageIds.push(String(argv[index + 1] ?? '').trim())
      index += 1
      continue
    }

    if (arg.startsWith('--stage=')) {
      options.selectedStageIds.push(arg.slice('--stage='.length).trim())
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  options.selectedStageIds = [...new Set(options.selectedStageIds.filter(Boolean))]
  const validIds = new Set(RELEASE_STAGES.map((stage) => stage.id))
  const invalidIds = options.selectedStageIds.filter((id) => !validIds.has(id))

  if (invalidIds.length > 0) {
    throw new Error(`Unknown release stage: ${invalidIds.join(', ')}`)
  }

  return options
}

function runGit(repoRoot, args, { encoding = 'utf8', maxBuffer = 256 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding,
    maxBuffer,
    windowsHide: true,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(
      String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim(),
    )
  }

  return result.stdout
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256')

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  return hash.digest('hex')
}

async function collectUntrackedEntries(repoRoot) {
  const output = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
  const relativePaths = output.split('\0').filter(Boolean).sort()
  const entries = []

  for (const relativePath of relativePaths) {
    const absolutePath = path.join(repoRoot, relativePath)
    const stats = await lstat(absolutePath)

    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      entries.push({
        path: relativePath,
        mode: 'symlink',
        hash: crypto.createHash('sha256').update(target).digest('hex'),
      })
      continue
    }

    if (stats.isFile()) {
      entries.push({
        path: relativePath,
        mode: 'file',
        hash: await hashFile(absolutePath),
      })
    }
  }

  return entries
}

async function collectWorkingTreeFingerprint(repoRoot) {
  const canonicalRoot = fs.realpathSync.native?.(repoRoot) ?? fs.realpathSync(repoRoot)
  const head = runGit(canonicalRoot, ['rev-parse', 'HEAD']).trim()
  const trackedDiff = runGit(canonicalRoot, ['diff', '--binary', 'HEAD', '--'])
  const untrackedEntries = await collectUntrackedEntries(canonicalRoot)
  const fingerprint = createVerificationFingerprint({
    repoRoot: canonicalRoot,
    head,
    trackedDiff,
    untrackedEntries,
  })

  return {
    repoRoot: canonicalRoot,
    head,
    fingerprint,
    trackedDiffBytes: Buffer.byteLength(trackedDiff),
    untrackedFileCount: untrackedEntries.length,
  }
}

function getStatePaths(repoRoot, fingerprint) {
  const repoKey = crypto.createHash('sha256').update(repoRoot.toLowerCase()).digest('hex').slice(0, 16)
  const baseRoot = process.env.CHILL_VIBE_RELEASE_VERIFY_DIR
    ? path.resolve(process.env.CHILL_VIBE_RELEASE_VERIFY_DIR)
    : path.join(os.tmpdir(), 'chill-vibe-release-verification')
  const fingerprintDir = path.join(baseRoot, repoKey, fingerprint)

  return {
    fingerprintDir,
    statePath: path.join(fingerprintDir, 'state.json'),
  }
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

async function writeState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true })
  const tempPath = `${statePath}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rm(statePath, { force: true })
  await rename(tempPath, statePath)
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return '-'
  }

  const seconds = Math.round(milliseconds / 100) / 10
  return `${seconds}s`
}

async function runStage(stage, repoRoot, logPath) {
  await mkdir(path.dirname(logPath), { recursive: true })
  const log = fs.createWriteStream(logPath, { flags: 'w' })
  const startedAt = new Date()
  const startedMs = Date.now()
  const header = [
    `[release-verify] stage=${stage.id}`,
    `[release-verify] command=${stage.commandText}`,
    `[release-verify] started=${startedAt.toISOString()}`,
    '',
  ].join('\n')
  log.write(header)

  console.log(`\n[release-verify] START ${stage.id}: ${stage.label}`)
  console.log(`[release-verify] ${stage.commandText}`)

  const invocation = createStageInvocation(stage)
  const exitCode = await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repoRoot,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      log.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      log.write(chunk)
    })
    child.on('error', (error) => {
      const message = `\n[release-verify] spawn error: ${error.message}\n`
      process.stderr.write(message)
      log.write(message)
      resolve(1)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })

  const completedAt = new Date()
  const durationMs = Date.now() - startedMs
  const status = exitCode === 0 ? 'passed' : 'failed'
  log.write(
    `\n[release-verify] completed=${completedAt.toISOString()}\n` +
      `[release-verify] duration_ms=${durationMs}\n` +
      `[release-verify] exit_code=${exitCode}\n`,
  )
  await new Promise((resolve) => log.end(resolve))

  console.log(
    `[release-verify] ${status === 'passed' ? 'PASS' : 'FAIL'} ${stage.id} (${formatDuration(durationMs)})`,
  )

  return {
    status,
    command: stage.commandText,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    exitCode,
    logPath,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/run-release-verification.mjs [options]

Options:
  --fresh           Rerun selected stages even when matching green evidence exists.
  --stage <id>      Run a specific stage; repeat for multiple stages.
  --plan            Print resume decisions without running commands.
  --help, -h        Show this help.

Stages: ${RELEASE_STAGES.map((stage) => stage.id).join(', ')}`)
}

function printPlan(plan, state) {
  console.log('\n[release-verify] plan')
  for (const stage of plan) {
    const evidence = state?.stages?.[stage.id]
    const duration = evidence?.durationMs ? `, previous ${formatDuration(evidence.durationMs)}` : ''
    console.log(`  ${stage.id.padEnd(12)} ${stage.action}${duration}`)
  }
}

function printSummary(stages, state) {
  console.log('\n[release-verify] summary')
  for (const stage of stages) {
    const evidence = state.stages?.[stage.id]
    const status = evidence?.status ?? 'missing'
    console.log(
      `  ${stage.id.padEnd(12)} ${status.padEnd(10)} ${formatDuration(evidence?.durationMs)}`,
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const initialTree = await collectWorkingTreeFingerprint(defaultProjectRoot)
  const { fingerprintDir, statePath } = getStatePaths(
    initialTree.repoRoot,
    initialTree.fingerprint,
  )
  const existingState = await readState(statePath)
  const loadedState =
    existingState?.fingerprint === initialTree.fingerprint
      ? existingState
      : {
          version: STATE_VERSION,
          fingerprint: initialTree.fingerprint,
          repoRoot: initialTree.repoRoot,
          head: initialTree.head,
          createdAt: new Date().toISOString(),
          stages: {},
        }
  const state = resetInvalidatedVerificationState(loadedState)

  console.log(`[release-verify] fingerprint: ${initialTree.fingerprint}`)
  console.log(`[release-verify] HEAD: ${initialTree.head}`)
  console.log(
    `[release-verify] tracked diff: ${initialTree.trackedDiffBytes} bytes; untracked files: ${initialTree.untrackedFileCount}`,
  )
  console.log(`[release-verify] evidence: ${fingerprintDir}`)

  const plan = resolveReleaseStagePlan({
    stages: RELEASE_STAGES,
    state,
    fingerprint: initialTree.fingerprint,
    fresh: options.fresh,
    selectedStageIds: options.selectedStageIds,
  })
  printPlan(plan, state)

  if (options.plan) {
    return
  }

  await writeState(statePath, state)

  for (const stage of plan) {
    if (stage.action !== 'run') {
      continue
    }

    const logPath = path.join(fingerprintDir, `${stage.id}.log`)
    state.stages[stage.id] = {
      status: 'running',
      command: stage.commandText,
      startedAt: new Date().toISOString(),
      logPath,
    }
    await writeState(statePath, state)

    state.stages[stage.id] = await runStage(stage, initialTree.repoRoot, logPath)
    state.updatedAt = new Date().toISOString()
    await writeState(statePath, state)
  }

  const finalTree = await collectWorkingTreeFingerprint(initialTree.repoRoot)
  if (finalTree.fingerprint !== initialTree.fingerprint) {
    state.invalidatedAt = new Date().toISOString()
    state.invalidatedByFingerprint = finalTree.fingerprint
    await writeState(statePath, state)
    console.error('\n[release-verify] working tree changed during verification; all evidence was invalidated.')
  }

  printSummary(RELEASE_STAGES, state)

  const allGreen =
    !state.invalidatedAt &&
    RELEASE_STAGES.every((stage) => {
      const evidence = state.stages?.[stage.id]
      return evidence?.status === 'passed' && evidence?.command === formatCommand(stage)
    })

  if (!allGreen) {
    console.error('\n[release-verify] RELEASE GATES NOT GREEN')
    process.exitCode = 1
    return
  }

  state.completedAt = new Date().toISOString()
  await writeState(statePath, state)
  console.log('\n[release-verify] ALL RELEASE GATES GREEN')
}

const directEntry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const moduleEntry = path.resolve(fileURLToPath(import.meta.url))

if (
  directEntry &&
  (process.platform === 'win32'
    ? directEntry.toLowerCase() === moduleEntry.toLowerCase()
    : directEntry === moduleEntry)
) {
  try {
    await main()
  } catch (error) {
    console.error(`[release-verify] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exitCode = 1
  }
}
