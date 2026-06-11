import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readNearestTsconfig } from '../server/tsconfig-discovery.js'
import { mapTsconfigToMonacoCompilerOptions } from '../src/components/text-editor-tsconfig.ts'

test('readNearestTsconfig finds the workspace root tsconfig', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-tsconfig-root-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'es2022', strict: true } }),
    'utf8',
  )
  await writeFile(path.join(workspace, 'src', 'index.ts'), 'export {}\n', 'utf8')

  const result = await readNearestTsconfig({
    workspacePath: workspace,
    relativePath: 'src/index.ts',
  })

  assert.deepEqual(result.compilerOptions, { target: 'es2022', strict: true })
})

test('readNearestTsconfig prefers the closest nested tsconfig', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-tsconfig-nested-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'packages', 'app', 'src'), { recursive: true })
  await writeFile(
    path.join(workspace, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'es5' } }),
    'utf8',
  )
  await writeFile(
    path.join(workspace, 'packages', 'app', 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'esnext' } }),
    'utf8',
  )

  const result = await readNearestTsconfig({
    workspacePath: workspace,
    relativePath: 'packages/app/src/main.ts',
  })

  assert.deepEqual(result.compilerOptions, { target: 'esnext' })
})

test('readNearestTsconfig tolerates JSONC comments and trailing commas', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-tsconfig-jsonc-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(
    path.join(workspace, 'tsconfig.json'),
    [
      '{',
      '  // project defaults',
      '  "compilerOptions": {',
      '    /* modern target */',
      '    "target": "es2020",',
      '    "jsx": "react-jsx",',
      '  },',
      '}',
    ].join('\n'),
    'utf8',
  )

  const result = await readNearestTsconfig({
    workspacePath: workspace,
    relativePath: 'index.ts',
  })

  assert.deepEqual(result.compilerOptions, { target: 'es2020', jsx: 'react-jsx' })
})

test('readNearestTsconfig returns null without a tsconfig', async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-tsconfig-none-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'index.ts'), 'export {}\n', 'utf8')

  const result = await readNearestTsconfig({
    workspacePath: workspace,
    relativePath: 'index.ts',
  })

  assert.equal(result.compilerOptions, null)
})

test('mapTsconfigToMonacoCompilerOptions maps known fields and drops unknown ones', () => {
  const mapped = mapTsconfigToMonacoCompilerOptions({
    target: 'ES2020',
    module: 'esnext',
    jsx: 'react-jsx',
    strict: true,
    esModuleInterop: true,
    allowJs: true,
    paths: { '@/*': ['./src/*'] },
    baseUrl: '.',
    outDir: 'dist',
    plugins: [{ name: 'whatever' }],
  })

  assert.equal(mapped.target, 7)
  assert.equal(mapped.module, 99)
  assert.equal(mapped.jsx, 4)
  assert.equal(mapped.strict, true)
  assert.equal(mapped.esModuleInterop, true)
  assert.equal(mapped.allowJs, true)
  assert.deepEqual(mapped.paths, { '@/*': ['./src/*'] })
  assert.equal(mapped.baseUrl, '.')
  assert.equal('outDir' in mapped, false)
  assert.equal('plugins' in mapped, false)
})

test('mapTsconfigToMonacoCompilerOptions survives junk values', () => {
  const mapped = mapTsconfigToMonacoCompilerOptions({
    target: 'not-a-target',
    module: 42,
    jsx: null,
    strict: 'yes',
  })

  assert.equal('target' in mapped, false)
  assert.equal('module' in mapped, false)
  assert.equal('jsx' in mapped, false)
  assert.equal('strict' in mapped, false)
})
