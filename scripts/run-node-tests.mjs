import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const defaultManifestPath = path.join(projectRoot, 'tests', 'index.test.ts')

export function parseRegisteredTestFiles(source) {
  const files = []
  const pattern = /^\s*import\s+['"](\.\/[^'"]+\.test\.(?:[cm]?js|tsx?))['"]\s*;?\s*$/gmu

  for (const match of source.matchAll(pattern)) {
    files.push(`tests/${match[1].slice(2)}`.replaceAll('\\', '/'))
  }

  return files
}

export function resolveFocusedTestFiles(registeredFiles, requestedFiles) {
  if (requestedFiles.length === 0) {
    return registeredFiles
  }

  const normalizedRequests = requestedFiles
    .flatMap((value) => value.split(/[,\s]+/u))
    .map((value) => value.trim().replace(/^\.\//u, '').replaceAll('\\', '/'))
    .filter(Boolean)
  const selected = []

  for (const request of normalizedRequests) {
    const matches = registeredFiles.filter((file) => {
      const basename = path.posix.basename(file)
      return file === request || file === `tests/${request}` || basename === request
    })

    if (matches.length === 0) {
      throw new Error(`Requested Node test is not registered in tests/index.test.ts: ${request}`)
    }

    for (const match of matches) {
      if (!selected.includes(match)) {
        selected.push(match)
      }
    }
  }

  return selected
}

export function createNodeTestArgs(files, concurrency, forceExit = false) {
  return [
    '--import',
    'tsx',
    '--test',
    ...(forceExit ? ['--test-force-exit'] : []),
    `--test-concurrency=${concurrency}`,
    ...files,
  ]
}

export function detectNodeTestForceExitSupport(execPath = process.execPath, probe = spawnSync) {
  const result = probe(execPath, ['--test-force-exit', '--test', '--help'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  return !result.error && result.status === 0
}

export function isDirectExecution(moduleUrl, argvEntry) {
  if (!argvEntry) {
    return false
  }

  const modulePath = path.resolve(fileURLToPath(moduleUrl))
  const entryPath = path.resolve(argvEntry)
  return process.platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return parsed
}

export function resolveDefaultConcurrency(
  platform = process.platform,
  available = os.availableParallelism?.() ?? os.cpus().length,
) {
  return Math.max(1, Math.min(platform === 'win32' ? 2 : 4, available))
}

function parseArgs(argv) {
  const defaultConcurrency = resolveDefaultConcurrency()
  const options = {
    concurrency: process.env.CHILL_VIBE_TEST_CONCURRENCY
      ? parsePositiveInteger(process.env.CHILL_VIBE_TEST_CONCURRENCY, 'CHILL_VIBE_TEST_CONCURRENCY')
      : defaultConcurrency,
    requestedFiles: [],
    list: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--list') {
      options.list = true
      continue
    }

    if (arg === '--concurrency') {
      options.concurrency = parsePositiveInteger(argv[index + 1], '--concurrency')
      index += 1
      continue
    }

    if (arg.startsWith('--concurrency=')) {
      options.concurrency = parsePositiveInteger(arg.slice('--concurrency='.length), '--concurrency')
      continue
    }

    if (arg === '--files') {
      options.requestedFiles.push(...String(argv[index + 1] ?? '').split(','))
      index += 1
      continue
    }

    if (arg.startsWith('--files=')) {
      options.requestedFiles.push(...arg.slice('--files='.length).split(','))
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  options.requestedFiles = options.requestedFiles.map((value) => value.trim()).filter(Boolean)
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifestSource = fs.readFileSync(defaultManifestPath, 'utf8')
  const registeredFiles = parseRegisteredTestFiles(manifestSource)

  if (registeredFiles.length === 0) {
    throw new Error('No Node test files are registered in tests/index.test.ts.')
  }

  const duplicateFiles = registeredFiles.filter((file, index) => registeredFiles.indexOf(file) !== index)
  if (duplicateFiles.length > 0) {
    throw new Error(`Duplicate Node test registrations: ${[...new Set(duplicateFiles)].join(', ')}`)
  }

  for (const file of registeredFiles) {
    if (!fs.existsSync(path.join(projectRoot, file))) {
      throw new Error(`Registered Node test file does not exist: ${file}`)
    }
  }

  const selectedFiles = resolveFocusedTestFiles(registeredFiles, options.requestedFiles)
  const supportsForceExit = detectNodeTestForceExitSupport()

  console.log(
    `[node-tests] ${selectedFiles.length}/${registeredFiles.length} registered files, concurrency=${options.concurrency}, forceExit=${supportsForceExit}`,
  )

  if (options.list) {
    for (const file of selectedFiles) {
      console.log(file)
    }
    return
  }

  const result = spawnSync(
    process.execPath,
    createNodeTestArgs(selectedFiles, options.concurrency, supportsForceExit),
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    },
  )

  if (result.error) {
    throw result.error
  }

  process.exitCode = result.status ?? 1
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(`[node-tests] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
