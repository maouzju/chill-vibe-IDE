import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  packageManualWindowsZip,
  WINDOWS_ZIP_ROOT_FOLDER_NAME,
  writeZipFromDirectory,
} from './manual-win-zip-packager.mjs'
import { patchWindowsExecutableIcon } from './windows-exe-icon.mjs'

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

function runCommand(command, args = [], { dryRun = false } = {}) {
  console.log(`\n[packaging] ${formatCommandForLog(command, args)}`)
  if (dryRun) {
    return
  }

  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `Command failed with exit code ${result.status}: ${formatCommandForLog(command, args)}`,
    )
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP_TEXT)
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
    [
      process.execPath,
      [
        'node_modules/electron-builder/cli.js',
        '--win',
        options.target,
        '--config.win.signAndEditExecutable=false',
        `--config.directories.output=${outputDirRelative}`,
      ],
    ],
  ]

  console.log(`[packaging] target: ${options.target}`)
  console.log(`[packaging] output: ${outputDirAbsolute}`)

  try {
    runCommand(legalCommand[0], legalCommand[1], { dryRun: options.dryRun })
  } catch (error) {
    const canReuseExistingLicenses =
      options.dryRun || fs.existsSync(path.join(projectRoot, 'THIRD_PARTY_LICENSES.md'))

    if (!canReuseExistingLicenses) {
      throw error
    }

    console.warn(
      `[packaging] warning: legal inventory refresh failed, reusing existing THIRD_PARTY_LICENSES.md`,
    )
  }

  for (const [command, args] of commands) {
    try {
      runCommand(command, args, { dryRun: options.dryRun })
    } catch (error) {
      const isFinalPackagingStep =
        command === process.execPath && args[0] === 'node_modules/electron-builder/cli.js'

      if (!isFinalPackagingStep || options.target !== 'zip' || options.dryRun) {
        throw error
      }

      console.warn(
        `[packaging] warning: electron-builder failed for zip packaging, falling back to manual zip assembly`,
      )

      const manualResult = await packageManualWindowsZip({
        projectRoot,
        outputDirAbsolute,
        version: rootPackageJson.version,
      })

      console.log(`[packaging] manual zip: ${manualResult.zipPath}`)
      console.log(`[packaging] manual unpacked dir: ${manualResult.winUnpackedDir}`)
      break
    }
  }

  if (!options.dryRun && fs.existsSync(exePath)) {
    await patchWindowsExecutableIcon({ executablePath: exePath })
    console.log(`[packaging] patched Windows app icon: ${exePath}`)
  }

  if (options.target === 'zip' && !options.dryRun) {
    if (!fs.existsSync(winUnpackedDir)) {
      throw new Error(`Expected unpacked app directory at ${winUnpackedDir}`)
    }

    writeZipFromDirectory(winUnpackedDir, zipPath, WINDOWS_ZIP_ROOT_FOLDER_NAME)
    console.log(`[packaging] zip artifact: ${zipPath}`)
    console.log(`[packaging] zip root folder: ${WINDOWS_ZIP_ROOT_FOLDER_NAME}`)
  }

  const targetLabel =
    options.target === 'nsis' ? 'installer' : options.target === 'portable' ? 'portable' : 'zip'

  console.log(`\n[packaging] done`)
  console.log(`[packaging] target kind: ${targetLabel}`)
  console.log(`[packaging] release dir: ${outputDirAbsolute}`)
  console.log(`[packaging] unpacked exe: ${exePath}`)
  console.log(`[packaging] note: each build uses its own timestamped release-* directory`)
}

try {
  await main()
} catch (error) {
  console.error(`[packaging] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
