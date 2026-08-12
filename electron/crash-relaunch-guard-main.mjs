// The out-of-tree guard process. Runs as plain Node inside the app binary
// (ELECTRON_RUN_AS_NODE), holds one named pipe open to the app, and brings the
// app back if that pipe closes without a clean-exit marker.
//
// Kept as hand-written .mjs on purpose: build-electron.mjs compiles only the
// import graph reachable from main.ts and copies .js/.mjs/.cjs verbatim, so a
// second process entry point has no other way into dist/electron/ without
// touching the build. All the logic worth testing lives in the compiled
// crash-relaunch-guard.js next to this file; this file is only the shell.
//
// It must never throw: an exception here costs the recovery entirely, while a
// silent stand-down costs one manual relaunch.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import {
  buildRelaunchEnv,
  decideGuardAction,
  parseGuardArgs,
  pruneRelaunchHistory,
} from './crash-relaunch-guard.js'

const args = parseGuardArgs(process.argv.slice(2))
if (!args) {
  process.exit(1)
}

const logPath = path.join(path.dirname(args.sentinelPath), 'logs', 'relaunch-guard.log')

const note = (message) => {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, line, 'utf8')
  } catch {
    // A guard that cannot log still has to guard.
  }
}

const readHistory = () => {
  try {
    const parsed = JSON.parse(fs.readFileSync(args.historyPath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((at) => typeof at === 'number') : []
  } catch {
    return []
  }
}

let settled = false

const onAppGone = () => {
  if (settled) {
    return
  }
  settled = true

  let sentinelText = null
  try {
    sentinelText = fs.readFileSync(args.sentinelPath, 'utf8')
  } catch {
    sentinelText = null
  }

  const nowMs = Date.now()
  const history = pruneRelaunchHistory(readHistory(), nowMs)
  const action = decideGuardAction(sentinelText, history, nowMs)
  note(`app gone -> ${action}`)

  if (action !== 'relaunch') {
    process.exit(0)
  }

  try {
    fs.writeFileSync(args.historyPath, JSON.stringify([...history, nowMs]), 'utf8')
  } catch {
    // Losing the history only weakens throttling; it must not block recovery.
  }

  try {
    // A fresh detached instance, parented to nothing we control, so the next
    // guard it spawns is likewise outside any tree that names this process.
    // buildRelaunchEnv strips ELECTRON_RUN_AS_NODE, which this guard needs for
    // itself but which would make the relaunched app start as a bare Node process.
    spawn(args.execPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: buildRelaunchEnv(process.env),
    }).unref()
    note(`relaunched ${args.execPath}`)
  } catch (error) {
    note(`relaunch failed: ${error && error.message ? error.message : String(error)}`)
  }

  process.exit(0)
}

const socket = net.connect(args.pipe)
socket.on('connect', () => {
  note(`attached to ${args.pipe}`)
})
// The pipe never carries data; only its lifetime matters.
socket.on('data', () => {})
socket.on('close', onAppGone)
socket.on('error', () => {
  // Failing to connect means the app was already gone before the guard was
  // ready. Standing down is correct: that death predates this guard's watch.
  if (!settled) {
    settled = true
    note('could not attach; standing down')
    process.exit(0)
  }
})
