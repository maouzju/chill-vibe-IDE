import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  packageManualWindowsZip,
  WINDOWS_ZIP_ROOT_FOLDER_NAME,
  writeZipFromDirectory,
} from './manual-win-zip-packager.mjs'
import { patchWindowsExecutableIcon } from './windows-exe-icon.mjs'
import { createReleaseLogRedactor, redactReleaseLogText } from './audit-release-safety.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const distDir = path.join(projectRoot, 'dist')

const HELP_TEXT = `
Usage:
  node scripts/build-timestamped-release.mjs [zip|installer|portable] [--dry-run]
  node scripts/build-timestamped-release.mjs --target <zip|nsis|portable> [--suffix custom] [--dry-run]

Defaults:
  - target: zip
  - output: dist/release-YYYYMMDD-HHmmss[-suffix]

Examples:
  node scripts/build-timestamped-release.mjs
  node scripts/build-timestamped-release.mjs installer
  node scripts/build-timestamped-release.mjs --target portable --suffix demo
  node scripts/build-timestamped-release.mjs --dry-run
`.trim()

// Each build drops a ~636MB release-* directory and never removed old ones, so
// dist grew unbounded (49 dirs / 31GB observed 2026-07-07). Keep the newest N
// and delete the rest. Pure/decidable so it can be unit-tested without touching
// disk; the caller does the actual rm. `keep` < 1 is treated as "keep all"
// (disables pruning) so an accidental 0 never wipes every build.
export function selectReleaseDirsToPrune(dirNames, keep, protectedNames = []) {
  const releases = dirNames
    .filter((name) => /^release-\d{8}-\d{6}/.test(name))
    .sort() // timestamped names sort chronologically as strings
  if (!Number.isFinite(keep) || keep < 1) {
    return []
  }
  const protectedSet = new Set(protectedNames)
  const kept = releases.slice(-keep)
  const keptSet = new Set(kept)
  return releases.filter((name) => !keptSet.has(name) && !protectedSet.has(name))
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
}

function sanitizeSegment(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

export function isDirectExecution(moduleUrl, argvEntry) {
  if (!argvEntry) {
    return false
  }

  try {
    const modulePath = path.resolve(fileURLToPath(moduleUrl))
    const entryPath = path.resolve(argvEntry)

    if (process.platform === 'win32') {
      return modulePath.toLowerCase() === entryPath.toLowerCase()
    }

    return modulePath === entryPath
  } catch {
    return false
  }
}

export function createElectronBuilderArgs(target, outputDirRelative) {
  const targetArgs = target === 'zip' ? ['--dir'] : [target]

  return [
    'node_modules/electron-builder/cli.js',
    '--win',
    ...targetArgs,
    '--config.win.signAndEditExecutable=false',
    `--config.directories.output=${outputDirRelative}`,
  ]
}

function parseArgs(argv) {
  const options = {
    target: 'zip',
    suffix: '',
    dryRun: false,
    timestamp: formatTimestamp(),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }

    if (arg === '--target') {
      options.target = argv[index + 1] ?? options.target
      index += 1
      continue
    }

    if (arg.startsWith('--target=')) {
      options.target = arg.slice('--target='.length) || options.target
      continue
    }

    if (arg === '--suffix') {
      options.suffix = argv[index + 1] ?? options.suffix
      index += 1
      continue
    }

    if (arg.startsWith('--suffix=')) {
      options.suffix = arg.slice('--suffix='.length) || options.suffix
      continue
    }

    if (arg === 'zip' || arg === 'portable' || arg === 'nsis') {
      options.target = arg
      continue
    }

    if (arg === 'installer') {
      options.target = 'nsis'
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  if (!['zip', 'nsis', 'portable'].includes(options.target)) {
    throw new Error(`Unsupported target: ${options.target}`)
  }

  options.suffix = sanitizeSegment(options.suffix)
  return options
}

function formatCommandForLog(command, args = []) {
  return [command, ...args]
    .map((part) => {
      const value = String(part ?? '')
      return /\s/u.test(value) ? `"${value}"` : value
    })
    .join(' ')
}

function writePackagingLog(text, options = {}) {
  const redacted = redactReleaseLogText(text, { repoRoot: projectRoot, env: process.env, ...options })
  process.stdout.write(redacted)
}

function logPackaging(message) {
  writePackagingLog(`${message}\n`)
}

function warnPackaging(message) {
  process.stderr.write(redactReleaseLogText(`${message}\n`, { repoRoot: projectRoot, env: process.env }))
}

async function runCommand(command, args = [], { dryRun = false } = {}) {
  writePackagingLog(`\n[packaging] ${formatCommandForLog(command, args)}\n`)
  if (dryRun) {
    return
  }

  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutRedactor = createReleaseLogRedactor({ repoRoot: projectRoot, env: process.env })
  const stderrRedactor = createReleaseLogRedactor({ repoRoot: projectRoot, env: process.env })
  const forward = (chunk, stream) => {
    const redactor = stream === process.stderr ? stderrRedactor : stdoutRedactor
    const value = redactor.push(chunk)
    if (value) stream.write(value)
  }
  child.stdout.on('data', (chunk) => forward(chunk, process.stdout))
  child.stderr.on('data', (chunk) => forward(chunk, process.stderr))
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (status, signal) => resolve({ status, signal }))
  })
  const stdoutTail = stdoutRedactor.flush()
  const stderrTail = stderrRedactor.flush()
  if (stdoutTail) process.stdout.write(stdoutTail)
  if (stderrTail) process.stderr.write(stderrTail)
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? 1}: ${formatCommandForLog(command, args)}`)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    logPackaging(HELP_TEXT)
    return
  }

  fs.mkdirSync(distDir, { recursive: true })

  const suffixPart = options.suffix ? `-${options.suffix}` : ''
  const outputDirName = `release-${options.timestamp}${suffixPart}`
  const outputDirRelative = path.posix.join('dist', outputDirName)
  const outputDirAbsolute = path.join(projectRoot, 'dist', outputDirName)
  const rootPackageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const winUnpackedDir = path.join(outputDirAbsolute, 'win-unpacked')
  const exePath = path.join(winUnpackedDir, 'Chill Vibe.exe')
  const zipPath = path.join(outputDirAbsolute, `Chill Vibe-${rootPackageJson.version}-win.zip`)

  const nodeCommand = process.execPath
  const legalCommand = [nodeCommand, ['scripts/generate-third-party-licenses.mjs']]
  const commands = [
    [nodeCommand, ['scripts/run-vite.mjs', 'build']],
    [nodeCommand, ['scripts/build-electron.mjs']],
    [process.execPath, createElectronBuilderArgs(options.target, outputDirRelative)],
  ]

  writePackagingLog(`[packaging] target: ${options.target}\n`)
  writePackagingLog(`[packaging] output: ${outputDirAbsolute}\n`)

  try {
    await runCommand(legalCommand[0], legalCommand[1], { dryRun: options.dryRun })
  } catch (error) {
    const canReuseExistingLicenses =
      options.dryRun || fs.existsSync(path.join(projectRoot, 'THIRD_PARTY_LICENSES.md'))

    if (!canReuseExistingLicenses) {
      throw error
    }

    warnPackaging(
      `[packaging] warning: legal inventory refresh failed, reusing existing THIRD_PARTY_LICENSES.md`,
    )
  }

  for (const [command, args] of commands) {
    try {
      await runCommand(command, args, { dryRun: options.dryRun })
    } catch (error) {
      const isFinalPackagingStep =
        command === process.execPath && args[0] === 'node_modules/electron-builder/cli.js'

      if (!isFinalPackagingStep || options.target !== 'zip' || options.dryRun) {
        throw error
      }

      warnPackaging(
        `[packaging] warning: electron-builder failed for zip packaging, falling back to manual zip assembly`,
      )

      const manualResult = await packageManualWindowsZip({
        projectRoot,
        outputDirAbsolute,
        version: rootPackageJson.version,
      })

      logPackaging(`[packaging] manual zip: ${manualResult.zipPath}`)
      logPackaging(`[packaging] manual unpacked dir: ${manualResult.winUnpackedDir}`)
      break
    }
  }

  if (!options.dryRun && fs.existsSync(exePath)) {
    await patchWindowsExecutableIcon({ executablePath: exePath })
    logPackaging(`[packaging] patched Windows app icon: ${exePath}`)
  }

  if (options.target === 'zip' && !options.dryRun) {
    if (!fs.existsSync(winUnpackedDir)) {
      throw new Error(`Expected unpacked app directory at ${winUnpackedDir}`)
    }

    writeZipFromDirectory(winUnpackedDir, zipPath, WINDOWS_ZIP_ROOT_FOLDER_NAME)
    logPackaging(`[packaging] zip artifact: ${zipPath}`)
    logPackaging(`[packaging] zip root folder: ${WINDOWS_ZIP_ROOT_FOLDER_NAME}`)
  }

  const targetLabel =
    options.target === 'nsis' ? 'installer' : options.target === 'portable' ? 'portable' : 'zip'

  logPackaging(`\n[packaging] done`)
  logPackaging(`[packaging] target kind: ${targetLabel}`)
  logPackaging(`[packaging] release dir: ${outputDirAbsolute}`)
  logPackaging(`[packaging] unpacked exe: ${exePath}`)
  logPackaging(`[packaging] note: each build uses its own timestamped release-* directory`)

  // Prune old builds so dist/ does not grow unbounded (~636MB each). Only after
  // a successful build, never in --dry-run. The just-built dir is protected even
  // if keep is small. CHILL_VIBE_KEEP_RELEASES overrides the default of 5; set
  // it to 0 (or negative) to disable pruning entirely.
  if (!options.dryRun) {
    const keepRaw = Number.parseInt(process.env.CHILL_VIBE_KEEP_RELEASES ?? '', 10)
    const keep = Number.isFinite(keepRaw) ? keepRaw : 5
    const dirNames = fs
      .readdirSync(distDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const toPrune = selectReleaseDirsToPrune(dirNames, keep, [outputDirName])
    for (const name of toPrune) {
      const fullPath = path.join(distDir, name)
      try {
        fs.rmSync(fullPath, { recursive: true, force: true })
        logPackaging(`[packaging] pruned old release: ${name}`)
      } catch (error) {
        warnPackaging(
          `[packaging] warning: could not prune ${name}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (toPrune.length > 0) {
      logPackaging(`[packaging] pruned ${toPrune.length} old release dir(s), kept newest ${keep}`)
    }
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(redactReleaseLogText(
      `[packaging] ${error instanceof Error ? error.message : String(error)}\n`,
      { repoRoot: projectRoot, env: process.env },
    ))
    process.exitCode = 1
  }
}
