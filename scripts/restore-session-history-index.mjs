#!/usr/bin/env node
/**
 * Rebuild the sessionHistory index in state.json from session-history sidecar
 * files.
 *
 * Why this exists: before the 2026-07 fix, a renderer crash capture persisted
 * a history index truncated to 20 entries, permanently dropping older archived
 * sessions from state.json even though their full sidecar files stayed on
 * disk. This script unions the surviving index with every readable sidecar,
 * sorts newest-first, re-applies the per-workspace cap, and writes the index
 * back (preview entries only — full transcripts stay in their sidecars).
 *
 * Usage:  node scripts/restore-session-history-index.mjs [dataDir] [--dry-run]
 *         dataDir defaults to %APPDATA%/chill-vibe-ide/data
 *
 * The app MUST be closed while this runs: a live instance holds the state in
 * memory and will overwrite the restored file on its next save.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const MAX_SESSION_HISTORY_PER_WORKSPACE = 50

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dataDirArg = args.find((arg) => !arg.startsWith('--'))
const dataDir = dataDirArg
  ?? path.join(process.env.APPDATA ?? '', 'chill-vibe-ide', 'data')

const fail = (message) => {
  console.error(`[restore] ${message}`)
  process.exit(1)
}

if (!dryRun && process.platform === 'win32') {
  const tasks = execSync('tasklist /FI "IMAGENAME eq Chill Vibe.exe" /FO CSV /NH', {
    encoding: 'utf8',
  })
  if (tasks.toLowerCase().includes('chill vibe.exe')) {
    fail('Chill Vibe is still running — close it first, or the app will overwrite the restored index.')
  }
}

const stateFilePath = path.join(dataDir, 'state.json')
const sidecarDir = path.join(dataDir, 'session-history')

const state = JSON.parse(readFileSync(stateFilePath, 'utf8'))
const existingEntries = Array.isArray(state.sessionHistory) ? state.sessionHistory : []
const existingIds = new Set(existingEntries.map((entry) => entry.id))
console.log(`[restore] state.json currently holds ${existingEntries.length} history entries`)

const toPreviewEntry = (entry) => ({
  ...entry,
  messages: [],
  messageCount: Math.max(entry.messageCount ?? 0, Array.isArray(entry.messages) ? entry.messages.length : 0),
  messagesPreview: true,
})

let unreadable = 0
const sidecarEntries = []
for (const fileName of readdirSync(sidecarDir)) {
  if (!fileName.endsWith('.json')) continue
  try {
    const entry = JSON.parse(readFileSync(path.join(sidecarDir, fileName), 'utf8'))
    if (!entry || typeof entry.id !== 'string' || typeof entry.workspacePath !== 'string') {
      unreadable += 1
      continue
    }
    if (existingIds.has(entry.id)) continue
    sidecarEntries.push(toPreviewEntry(entry))
  } catch {
    unreadable += 1
  }
}
console.log(`[restore] readable sidecar entries missing from the index: ${sidecarEntries.length} (unreadable/invalid skipped: ${unreadable})`)

const archivedAtOf = (entry) => Date.parse(entry.archivedAt ?? '') || 0
const merged = [...existingEntries.map(toPreviewEntry), ...sidecarEntries]
  .sort((a, b) => archivedAtOf(b) - archivedAtOf(a))

const workspaceCounts = new Map()
const capped = merged.filter((entry) => {
  const key = (entry.workspacePath ?? '').toLowerCase()
  const count = (workspaceCounts.get(key) ?? 0) + 1
  workspaceCounts.set(key, count)
  return count <= MAX_SESSION_HISTORY_PER_WORKSPACE
})

console.log(`[restore] rebuilt index: ${capped.length} entries across ${workspaceCounts.size} workspaces (per-workspace cap ${MAX_SESSION_HISTORY_PER_WORKSPACE})`)
for (const [workspace, count] of [...workspaceCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`[restore]   ${workspace}: ${Math.min(count, MAX_SESSION_HISTORY_PER_WORKSPACE)} kept (${count} candidates)`)
}

if (dryRun) {
  console.log('[restore] dry run — state.json not modified')
  process.exit(0)
}

const backupPath = path.join(
  dataDir,
  `state.backup-before-history-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
)
copyFileSync(stateFilePath, backupPath)
console.log(`[restore] backup written: ${backupPath}`)

state.sessionHistory = capped
state.updatedAt = new Date().toISOString()
writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(`[restore] state.json updated with ${capped.length} history entries`)
