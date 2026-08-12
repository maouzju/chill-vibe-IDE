import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const distDir = path.join(projectRoot, 'dist')
const electronOutDir = path.join(distDir, 'electron')
const serverOutDir = path.join(distDir, 'server')
const sharedOutDir = path.join(distDir, 'shared')
const tscCliPath = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc')

function runNodeScript(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }
}

async function cleanBuildOutputs() {
  await Promise.all(
    [electronOutDir, serverOutDir, sharedOutDir].map((target) =>
      fs.rm(target, { recursive: true, force: true }),
    ),
  )
}

async function copyRuntimeAssets() {
  const roots = [
    { source: path.join(projectRoot, 'electron'), target: electronOutDir },
    { source: path.join(projectRoot, 'server'), target: serverOutDir },
    { source: path.join(projectRoot, 'shared'), target: sharedOutDir },
  ]

  for (const { source, target } of roots) {
    await copyRuntimeAssetsInto(source, source, target)
  }
}

async function copyRuntimeAssetsInto(rootDir, currentDir, targetRoot) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const sourcePath = path.join(currentDir, entry.name)

    if (entry.isDirectory()) {
      await copyRuntimeAssetsInto(rootDir, sourcePath, targetRoot)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const extension = path.extname(entry.name).toLowerCase()
    const shouldCopy =
      extension === '.js' ||
      extension === '.mjs' ||
      extension === '.cjs' ||
      extension === '.node' ||
      (extension === '.json' && !/^tsconfig(?:\..+)?\.json$/i.test(entry.name))

    if (!shouldCopy) {
      continue
    }

    const relativePath = path.relative(rootDir, sourcePath)
    const targetPath = path.join(targetRoot, relativePath)
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.copyFile(sourcePath, targetPath)
  }
}

// 症状：`dist/electron/utility-host.js` 根本不存在，打包版启动后端进程直接失败。
// 根因：tsc 只编译显式传入的入口 + 它们的 import 图。utility host 是被
//   `utilityProcess.fork` 按路径加载的，main.ts 永远不会 import 它，所以不列成
//   第二个入口就一个字节都不会产出 —— 现成反例：`server/index.ts` 至今没有产物。
// 为什么不能靠 copyRuntimeAssets 兜底：那一步只复制 .js/.mjs/.cjs/.json，
//   TypeScript 源文件不在其列。
function compileElectronMain() {
  runNodeScript([
    tscCliPath,
    'electron/main.ts',
    'electron/utility-host.ts',
    // 主进程侧的代理。接线完成后 main.ts 会 import 它、import 图自然带出，
    // 但显式列出来的成本是零，而漏产物的表现是"打包版后端静默不可用"。
    'electron/backend-rpc-client.ts',
    '--outDir',
    'dist',
    '--rootDir',
    '.',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2023',
    '--lib',
    'ES2023',
    '--types',
    'node',
    '--skipLibCheck',
    '--verbatimModuleSyntax',
    '--allowSyntheticDefaultImports',
    '--esModuleInterop',
    '--noCheck',
  ])
}

async function rewriteRelativeTsSpecifiers(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name)

    if (entry.isDirectory()) {
      await rewriteRelativeTsSpecifiers(fullPath)
      continue
    }

    if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/i.test(entry.name)) {
      continue
    }

    const original = await fs.readFile(fullPath, 'utf8')
    const updated = original.replace(
      /((?:from\s+['"]|import\(\s*['"]|require\(\s*['"]))(\.{1,2}\/[^'"]+?)\.(ts|tsx)(['"]\s*\)?)/g,
      '$1$2.js$4',
    )

    if (updated !== original) {
      await fs.writeFile(fullPath, updated, 'utf8')
    }
  }
}

async function compilePreload() {
  const preloadSourcePath = path.join(projectRoot, 'electron', 'preload.ts')
  const attachmentProtocolPath = path.join(projectRoot, 'shared', 'attachment-protocol.ts')
  const preloadSource = await fs.readFile(preloadSourcePath, 'utf8')
  const attachmentProtocolSource = (await fs.readFile(attachmentProtocolPath, 'utf8')).replace(
    /^export\s+/gm,
    '',
  )

  const inlinedSource = preloadSource.replace(
    /^import\s+\{\s*getAttachmentProtocolUrl\s*\}\s+from\s+['"]\.\.\/shared\/attachment-protocol\.js['"]\s*\r?\n/m,
    `${attachmentProtocolSource}\n\n`,
  )

  if (inlinedSource === preloadSource) {
    throw new Error('Failed to inline shared attachment protocol helper for preload build.')
  }

  const transpiled = ts.transpileModule(inlinedSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
    fileName: preloadSourcePath,
  })

  await fs.mkdir(electronOutDir, { recursive: true })
  await fs.writeFile(path.join(electronOutDir, 'preload.cjs'), transpiled.outputText, 'utf8')
}

async function finalizeElectronMain() {
  const mainJsPath = path.join(electronOutDir, 'main.js')
  const mainMjsPath = path.join(electronOutDir, 'main.mjs')

  await fs.rm(mainMjsPath, { force: true })
  await fs.rename(mainJsPath, mainMjsPath)
  await fs.writeFile(
    path.join(electronOutDir, 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'utf8',
  )
}

async function main() {
  await cleanBuildOutputs()
  compileElectronMain()
  await copyRuntimeAssets()
  await Promise.all([
    rewriteRelativeTsSpecifiers(electronOutDir),
    rewriteRelativeTsSpecifiers(serverOutDir),
    rewriteRelativeTsSpecifiers(sharedOutDir),
  ])
  await compilePreload()
  await finalizeElectronMain()
}

main().catch((error) => {
  console.error('[electron:compile]', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
