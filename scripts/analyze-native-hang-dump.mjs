#!/usr/bin/env node
// Read a freeze minidump and print which module each thread is parked in.
//
// Usage:
//   node scripts/analyze-native-hang-dump.mjs <dump.dmp>
//   node scripts/analyze-native-hang-dump.mjs            # newest dump in the app data dir
//
// This needs no WinDbg, no cdb and no symbol server — it attributes addresses
// to loaded modules, which is enough to tell a GPU-driver hang from a Chromium
// hang from a kernel wait.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { readNativeHangMinidump } = await import(
  pathToFileURL(path.resolve(import.meta.dirname, '../dist/electron/minidump-reader.mjs')).href
).catch(async () => await import('tsx/esm/api').then(async (api) => {
  const unregister = api.register()
  const mod = await import(pathToFileURL(path.resolve(import.meta.dirname, '../electron/minidump-reader.ts')).href)
  unregister()
  return mod
}))

const defaultDumpDirectory = () =>
  path.join(
    process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '.', 'AppData/Roaming'),
    'chill-vibe-ide',
    'data',
    'crash-dumps',
    'reports',
  )

const newestDump = (directory) => {
  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith('.dmp'))
    .map((entry) => {
      const full = path.join(directory, entry)
      return { full, mtimeMs: statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (entries.length === 0) {
    throw new Error(`no .dmp files in ${directory}`)
  }
  return entries[0].full
}

const target = process.argv[2] ?? newestDump(defaultDumpDirectory())
const report = readNativeHangMinidump(readFileSync(target))

console.log(`dump: ${target}`)
console.log(`modules loaded: ${report.modules.length}`)
console.log('')

for (const thread of report.threads) {
  console.log(`thread ${thread.threadId}  [${thread.suspectedNativeOwner}]`)
  console.log(`  blocked at: ${thread.instructionPointer}`)
  if (thread.stackModules.length > 0) {
    console.log(`  stack:      ${thread.stackModules.slice(0, 12).join(' <- ')}`)
  }
  console.log('')
}

const gpuThreads = report.threads.filter((thread) => thread.suspectedNativeOwner === 'gpu-driver')
if (gpuThreads.length > 0) {
  console.log(
    `VERDICT: ${gpuThreads.length} thread(s) parked inside graphics-driver code — the hang is below the renderer, not in app JS.`,
  )
} else {
  console.log('VERDICT: no thread parked in graphics-driver code.')
}
