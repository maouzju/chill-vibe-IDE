import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const outDir = path.join(projectRoot, 'dist', 'electron')
const mainJsPath = path.join(outDir, 'main.js')
const mainMjsPath = path.join(outDir, 'main.mjs')

await mkdir(outDir, { recursive: true })
await rm(mainMjsPath, { force: true })
await rename(mainJsPath, mainMjsPath)
await writeFile(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  'utf8',
)
