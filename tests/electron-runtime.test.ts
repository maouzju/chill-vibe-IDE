import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  resolveDesktopDataDir,
  resolveDesktopRuntimeProfilePaths,
  resolveDesktopWorkingDirectory,
} from '../electron/runtime-environment.ts'
import { getRendererLoadTarget } from '../electron/runtime-target.ts'
import {
  powerShellCommand,
  prependPathEntry,
  writeArgCaptureShim,
} from './test-shell-helpers.ts'

test('production Electron loads the bundled renderer from disk', () => {
  const target = getRendererLoadTarget({
    isDev: false,
    clientDistDir: path.join(process.cwd(), 'dist', 'client'),
    devServerUrl: 'http://localhost:5173',
  })

  assert.equal(target.kind, 'file')
  assert.match(target.value, /dist[\\/]client[\\/]index\.html$/)
})

test('development Electron keeps the Vite renderer target', () => {
  const target = getRendererLoadTarget({
    isDev: true,
    clientDistDir: path.join(process.cwd(), 'dist', 'client'),
    devServerUrl: 'http://localhost:5173',
  })

  assert.deepEqual(target, {
    kind: 'url',
    value: 'http://localhost:5173',
  })
})

test('packaged Electron does not chdir into the bundled app.asar path', () => {
  const packagedModuleDir = path.join(
    'C:',
    'Users',
    'tester',
    'AppData',
    'Local',
    'Chill Vibe',
    'resources',
    'app.asar',
    'dist',
    'electron',
  )

  assert.equal(
    resolveDesktopWorkingDirectory({
      isDev: false,
      moduleDir: packagedModuleDir,
    }),
    null,
  )
})

test('development Electron uses a repo-local runtime profile so it does not share Chromium state with packaged builds', () => {
  const projectRoot = path.join('D:', 'Git', 'chill-vibe')

  assert.deepEqual(
    resolveDesktopRuntimeProfilePaths({
      isDev: true,
      projectRoot,
    }),
    {
      userData: path.join(projectRoot, '.chill-vibe', 'electron-dev', 'user-data'),
      sessionData: path.join(projectRoot, '.chill-vibe', 'electron-dev', 'session-data'),
    },
  )
})

test('packaged Electron keeps the default OS-managed runtime profile paths', () => {
  assert.equal(
    resolveDesktopRuntimeProfilePaths({
      isDev: false,
      projectRoot: path.join('D:', 'Git', 'chill-vibe'),
    }),
    null,
  )
})

test('development Electron ignores an inherited shared data dir by default', () => {
  const projectRoot = path.join('D:', 'Git', 'chill-vibe')

  assert.equal(
    resolveDesktopDataDir({
      isDev: true,
      projectRoot,
      userDataPath: path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'chill-vibe-electron-dev'),
      configuredDataDir: path.join('D:', 'shared', 'chill-vibe-data'),
      allowConfiguredOverride: false,
    }),
    path.join(projectRoot, '.chill-vibe'),
  )
})

test('packaged Electron ignores an inherited shared data dir by default', () => {
  assert.equal(
    resolveDesktopDataDir({
      isDev: false,
      projectRoot: path.join('D:', 'Git', 'chill-vibe'),
      userDataPath: path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'chill-vibe-ide'),
      configuredDataDir: path.join('D:', 'shared', 'chill-vibe-data'),
      allowConfiguredOverride: false,
    }),
    path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'chill-vibe-ide', 'data'),
  )
})

test('Electron only honors an explicit shared data dir override when isolation is opt-in', () => {
  const configuredDataDir = path.join('D:', 'shared', 'chill-vibe-data')

  assert.equal(
    resolveDesktopDataDir({
      isDev: false,
      projectRoot: path.join('D:', 'Git', 'chill-vibe'),
      userDataPath: path.join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'chill-vibe-ide'),
      configuredDataDir,
      allowConfiguredOverride: true,
    }),
    configuredDataDir,
  )
})

test('package scripts no longer expose browser runtime entrypoints', async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>
  }

  assert.equal(typeof packageJson.scripts?.dev, 'string')
  assert.equal(packageJson.scripts?.dev, 'pnpm electron:dev')
  assert.equal('dev:web' in (packageJson.scripts ?? {}), false)
  assert.equal('dev:server' in (packageJson.scripts ?? {}), false)
  assert.equal('build:server' in (packageJson.scripts ?? {}), false)
  assert.equal('start:web' in (packageJson.scripts ?? {}), false)
  assert.equal('preview' in (packageJson.scripts ?? {}), false)
})

test('package scripts expose risk and full regression entrypoints', async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>
  }

  assert.equal(
    packageJson.scripts?.['test:theme'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Suite theme',
  )
  assert.equal(
    packageJson.scripts?.['test:theme:headed'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Suite theme -Mode headed',
  )
  assert.equal(
    packageJson.scripts?.['test:playwright'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1',
  )
  assert.equal(
    packageJson.scripts?.['test:playwright:headed'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Mode headed',
  )
  assert.equal(
    packageJson.scripts?.['test:playwright:full'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Suite full',
  )
  assert.equal(
    packageJson.scripts?.['test:perf'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-performance-smoke.ps1',
  )
  assert.equal(
    packageJson.scripts?.['test:perf:headed'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-performance-smoke.ps1 -Mode headed',
  )
  assert.equal(
    packageJson.scripts?.['test:perf:electron'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-electron-runtime-tests.ps1 -Tests tests/electron-git-tool-runtime.test.ts,tests/electron-git-stage-performance.test.ts',
  )
  assert.equal(
    packageJson.scripts?.['test:electron'],
    'powershell -ExecutionPolicy Bypass -File scripts/run-electron-runtime-tests.ps1',
  )
  assert.equal(
    packageJson.scripts?.['test:risk'],
    'pnpm test:quality && pnpm test && pnpm test:playwright && pnpm test:electron',
  )
  assert.equal(
    packageJson.scripts?.['test:full'],
    'pnpm legal:check && pnpm test:quality && pnpm test && pnpm test:playwright:full && pnpm test:electron && pnpm build',
  )
  assert.equal(packageJson.scripts?.verify, 'pnpm test:full')
})

test('Electron build emits an ESM main bundle and a CJS preload bundle', async () => {
  const projectRoot = process.cwd()
  const packageJsonPath = path.join(projectRoot, 'package.json')
  const [packageJsonBody, buildElectronScriptBody, electronPackageWriterBody] = await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'build-electron.mjs'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'write-electron-package.mjs'), 'utf8'),
  ])
  const packageJson = JSON.parse(packageJsonBody) as {
    main?: string
    scripts?: Record<string, string>
  }

  assert.equal(packageJson.main, 'dist/electron/main.mjs')
  assert.equal(packageJson.scripts?.['electron:compile'], 'node scripts/build-electron.mjs')
  assert.match(buildElectronScriptBody, /compileElectronMain\(\)/)
  assert.match(buildElectronScriptBody, /compilePreload\(\)/)
  assert.match(buildElectronScriptBody, /ModuleKind\.CommonJS/)
  assert.match(buildElectronScriptBody, /await finalizeElectronMain\(\)/)
  assert.equal(
    buildElectronScriptBody.includes("!/^tsconfig(?:\\..+)?\\.json$/i.test(entry.name)"),
    true,
  )
  assert.match(electronPackageWriterBody, /type:\s*'module'/)
  assert.match(electronPackageWriterBody, /main\.js/)
  assert.match(electronPackageWriterBody, /main\.mjs/)
})

test('package start script clears ELECTRON_RUN_AS_NODE before launching Electron', async () => {
  const projectRoot = process.cwd()
  const [packageJsonBody, startScriptBody] = await Promise.all([
    readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    readFile(path.join(projectRoot, 'scripts', 'start-electron-prod.mjs'), 'utf8'),
  ])
  const packageJson = JSON.parse(packageJsonBody) as {
    scripts?: Record<string, string>
  }

  assert.equal(packageJson.scripts?.start, 'node scripts/start-electron-prod.mjs')
  assert.match(startScriptBody, /delete sharedEnv\.ELECTRON_RUN_AS_NODE/)
  assert.match(startScriptBody, /spawn\(electronBinary, \['\.'\]/)
})

test('Electron quit flow flushes renderer persistence and waits for queued state writes before exit', async () => {
  const projectRoot = process.cwd()
  const [mainBody, preloadBody, persistenceBody] = await Promise.all([
    readFile(path.join(projectRoot, 'electron', 'main.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'electron', 'preload.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src', 'hooks', 'usePersistence.ts'), 'utf8'),
  ])

  assert.match(mainBody, /webContents\.send\('app:flush-state-before-quit'\)/)
  assert.match(mainBody, /await desktopBackend\.flushStateWrites\(\)/)
  assert.match(preloadBody, /ipcRenderer\.on\('app:flush-state-before-quit'/)
  assert.match(preloadBody, /window\.dispatchEvent\(new Event\('chill-vibe:flush-state-before-quit'\)\)/)
  assert.match(persistenceBody, /window\.addEventListener\('chill-vibe:flush-state-before-quit', handlePageHide\)/)
})

test('development Electron retries renderer bootstrap when the dev shell loads with an empty root', async () => {
  const projectRoot = process.cwd()
  const [mainBody, rendererEntryBody] = await Promise.all([
    readFile(path.join(projectRoot, 'electron', 'main.ts'), 'utf8'),
    readFile(path.join(projectRoot, 'src', 'main.tsx'), 'utf8'),
  ])

  assert.match(mainBody, /Dev bootstrap import failed/)
  assert.match(mainBody, /cv-dev-boot=/)
  assert.match(mainBody, /root\.childElementCount > 0/)
  assert.match(rendererEntryBody, /__CHILL_VIBE_ROOT__/)
  assert.match(rendererEntryBody, /bootstrapWindow\.__CHILL_VIBE_ROOT__ = appRoot/)
})

test('README verification docs match the packaged regression scripts in both languages', async () => {
  const [readmeBody, packageJsonBody] = await Promise.all([
    readFile(path.join(process.cwd(), 'README.md'), 'utf8'),
    readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ])
  const packageJson = JSON.parse(packageJsonBody) as {
    scripts?: Record<string, string>
  }

  assert.equal(packageJson.scripts?.['test:playwright'], 'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1')
  assert.equal(packageJson.scripts?.['test:playwright:headed'], 'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Mode headed')
  assert.equal(packageJson.scripts?.['test:playwright:full'], 'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Suite full')
  assert.equal(packageJson.scripts?.['test:theme:headed'], 'powershell -ExecutionPolicy Bypass -File scripts/run-playwright-specs.ps1 -Suite theme -Mode headed')
  assert.equal(packageJson.scripts?.['test:perf'], 'powershell -ExecutionPolicy Bypass -File scripts/run-performance-smoke.ps1')
  assert.equal(packageJson.scripts?.['test:perf:headed'], 'powershell -ExecutionPolicy Bypass -File scripts/run-performance-smoke.ps1 -Mode headed')
  assert.equal(packageJson.scripts?.['test:perf:electron'], 'powershell -ExecutionPolicy Bypass -File scripts/run-electron-runtime-tests.ps1 -Tests tests/electron-git-tool-runtime.test.ts,tests/electron-git-stage-performance.test.ts')
  assert.equal(packageJson.scripts?.['test:risk'], 'pnpm test:quality && pnpm test && pnpm test:playwright && pnpm test:electron')
  assert.equal(packageJson.scripts?.['test:full'], 'pnpm legal:check && pnpm test:quality && pnpm test && pnpm test:playwright:full && pnpm test:electron && pnpm build')

  assert.match(readmeBody, /- `pnpm test:playwright` runs the default Playwright smoke suite for day-to-day regressions in headless mode\./)
  assert.match(readmeBody, /- `pnpm test:playwright:headed` runs the same Playwright smoke suite with a visible browser for local debugging\./)
  assert.match(readmeBody, /- `pnpm test:playwright:full` runs the full Playwright browser-flow regression suite\./)
  assert.match(readmeBody, /- `pnpm test:theme` runs the Playwright theme and board-layout regression checks through the repo harness in headless mode\./)
  assert.match(readmeBody, /- `pnpm test:theme:headed` runs the same theme checks with a visible browser when you need to inspect UI behavior live\./)
  assert.match(readmeBody, /- `pnpm test:perf` runs the headless browser-performance smoke slice: long-chat compaction logic, layout memoization safeguards, and the add-card freeze regression\./)
  assert.match(readmeBody, /- `pnpm test:perf:headed` runs that same browser-performance smoke slice with a visible browser\./)
  assert.match(readmeBody, /- `pnpm test:perf:electron` runs the real-window Electron responsiveness smoke for desktop-only performance issues\./)
  assert.match(readmeBody, /- `pnpm test:risk` runs lint, type checks, Node tests, the Playwright smoke suite, and Electron runtime checks\./)
  assert.match(readmeBody, /- `pnpm test:full` runs the legal inventory check, lint, type checks, Node tests, the full Playwright suite, Electron runtime checks, and the production build\./)

  assert.match(readmeBody, /- `pnpm test:playwright` 运行默认 Playwright smoke 回归测试。/)
  assert.match(readmeBody, /- `pnpm test:playwright:full` 运行完整的 Playwright 浏览器流程回归测试。/)
  assert.match(readmeBody, /- `pnpm test:risk` 运行 lint、类型检查、Node 测试、Playwright smoke 套件和 Electron 运行时检查。/)
  assert.match(readmeBody, /- `pnpm test:full` 运行 legal 清单校验、lint、类型检查、Node 测试、完整 Playwright 套件、Electron 运行时检查和生产构建。/)
})

test('package scripts restart the active Electron runtime instead of only the renderer server', async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>
  }

  assert.equal(
    packageJson.scripts?.['dev:restart'],
    'powershell -ExecutionPolicy Bypass -File scripts/restart-runtime.ps1',
  )
})

test('packaged builds bundle the one-click environment setup script as an Electron resource', async () => {
  const packageJsonPath = path.join(process.cwd(), 'package.json')
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    build?: {
      extraResources?: Array<{ from?: string; to?: string }>
    }
  }

  assert.deepEqual(
    packageJson.build?.extraResources?.find(
      (entry) => entry.from === 'scripts/setup-ai-cli.ps1',
    ),
    {
      from: 'scripts/setup-ai-cli.ps1',
      to: 'scripts/setup-ai-cli.ps1',
    },
  )
})

test('repo ships a local full-regression skill for future risky changes', async () => {
  const skillPath = path.join(
    process.cwd(),
    '.codex',
    'skills',
    'chill-vibe-full-regression',
    'SKILL.md',
  )
  const skillBody = await readFile(skillPath, 'utf8')

  assert.match(skillBody, /^---[\s\S]*name:\s*chill-vibe-full-regression/m)
  assert.match(skillBody, /After each risky change,\s+run `pnpm test:risk`/i)
  assert.match(skillBody, /Before handoff,\s+run `pnpm test:full`/i)
  assert.match(skillBody, /For Git-related UI work, include the switch flow/i)
})

test('playwright runner script accepts a single spec path', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-playwright-script-'))
  const stubLogPath = path.join(tempDir, 'pnpm-args.txt')
  await writeArgCaptureShim({ dir: tempDir, name: 'pnpm', logEnvVar: 'STUB_LOG' })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        powerShellCommand,
        [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/run-playwright-specs.ps1',
          'tests/git-tool-switch.spec.ts',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: prependPathEntry(tempDir, process.env.PATH ?? ''),
            STUB_LOG: stubLogPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )

      let stderr = ''

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `script failed with code ${code}`))
      })
    })

    const capturedArgs = await readFile(stubLogPath, 'utf8')
    assert.match(capturedArgs, /exec playwright test tests\/git-tool-switch\.spec\.ts/i)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('playwright runner script expands named suites through the repo harness', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-playwright-suite-script-'))
  const stubLogPath = path.join(tempDir, 'pnpm-suite-args.txt')
  await writeArgCaptureShim({ dir: tempDir, name: 'pnpm', logEnvVar: 'STUB_LOG' })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        powerShellCommand,
        [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/run-playwright-specs.ps1',
          '-Suite',
          'theme',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: prependPathEntry(tempDir, process.env.PATH ?? ''),
            STUB_LOG: stubLogPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )

      let stderr = ''

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `script failed with code ${code}`))
      })
    })

    const capturedArgs = await readFile(stubLogPath, 'utf8')
    assert.match(capturedArgs, /exec playwright test tests\/theme-check\.spec\.ts tests\/board-layout\.spec\.ts/i)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('playwright runner script forwards headed mode to Playwright', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-playwright-headed-script-'))
  const stubLogPath = path.join(tempDir, 'pnpm-headed-args.txt')
  await writeArgCaptureShim({ dir: tempDir, name: 'pnpm', logEnvVar: 'STUB_LOG' })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        powerShellCommand,
        [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/run-playwright-specs.ps1',
          '-Specs',
          'tests/add-card-freeze.spec.ts',
          '-Mode',
          'headed',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: prependPathEntry(tempDir, process.env.PATH ?? ''),
            STUB_LOG: stubLogPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )

      let stderr = ''

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `script failed with code ${code}`))
      })
    })

    const capturedArgs = await readFile(stubLogPath, 'utf8')
    assert.match(capturedArgs, /exec playwright test tests\/add-card-freeze\.spec\.ts --headed/i)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('performance smoke runner uses headless node checks and the add-card freeze Playwright regression by default', async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'chill-vibe-performance-smoke-script-'))
  const nodeLogPath = path.join(tempDir, 'node-args.txt')
  const pnpmLogPath = path.join(tempDir, 'pnpm-args.txt')
  await writeArgCaptureShim({ dir: tempDir, name: 'node', logEnvVar: 'NODE_LOG' })
  await writeArgCaptureShim({ dir: tempDir, name: 'pnpm', logEnvVar: 'PNPM_LOG' })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        powerShellCommand,
        [
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          'scripts/run-performance-smoke.ps1',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            PATH: prependPathEntry(tempDir, process.env.PATH ?? ''),
            NODE_LOG: nodeLogPath,
            PNPM_LOG: pnpmLogPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )

      let stderr = ''

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }

        reject(new Error(stderr.trim() || `script failed with code ${code}`))
      })
    })

    const [capturedNodeArgs, capturedPnpmArgs] = await Promise.all([
      readFile(nodeLogPath, 'utf8'),
      readFile(pnpmLogPath, 'utf8'),
    ])

    assert.match(
      capturedNodeArgs,
      /--import tsx --test tests\/chat-card-compaction\.test\.ts tests\/layout-memoization\.test\.ts/i,
    )
    assert.match(capturedPnpmArgs, /exec playwright test tests\/add-card-freeze\.spec\.ts/i)
    assert.doesNotMatch(capturedPnpmArgs, /--headed/i)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
