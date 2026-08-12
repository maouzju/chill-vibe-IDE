// Decides whether the previous run died a natural death or was killed, and
// whether recovering from that is safe.
//
// Symptom: 2026-08-11 22:44:25 the window vanished with none of the six
// shutdown lines in main.log, no minidump, no Windows event, and commit
// pressure at "normal" -- the signature of an external TerminateProcess. The
// user had to notice and relaunch by hand.
// Root cause: still open, and deliberately not encoded here. The one kill ever
// caught in the act (2026-08-12 01:21:09, pid 5960, exit code -1) was this
// repo's own `scripts/verify-crash-relaunch.ps1` mistaking the user's instance
// for the one it had spawned; that path is fixed and fenced by
// `scripts/lib/kill-guard.ps1`. The earlier 08-10/08-11 hard exits have no exit
// code recorded (the watcher only came up 08-12 00:45), so their killer is
// unknown.
// What was ruled out: the "Claude Code's killProcessTree hits a recycled PID"
// theory this file originally carried. Three independent refutations --
// `watch-app-kill.ps1` sat armed for 1h47m across a real death with zero hits;
// no such report exists upstream; and Windows only frees a PID when the last
// handle to it closes, so a spawned child's PID is pinned as a zombie and
// cannot be reused at all. That CLI is careless (bare-PID `taskkill /T /F`
// under `stdio:"ignore"`), but its exit code is 1 and the caught kill was -1.
// Why recovery rather than prevention: whatever holds the knife, nothing in
// user space can refuse TerminateProcess, so coming back is the only defence
// available to the app itself.
// Why the start time matters: a watchdog that checks "is PID N alive" is
// unsound regardless of the killer -- PID identity is only meaningful as
// (pid, start time), never the pid alone.

export type RunSentinel = {
  pid: number
  /** Process start time, the half of the identity that a recycled PID cannot forge. */
  startedAtIso: string
  /** Set by the app's own shutdown path; its absence is what marks a kill. */
  cleanExit: boolean
}

export type ProcessProbe = {
  alive: boolean
  /** Absent when the OS would not tell us; treated as "cannot confirm identity". */
  startedAtIso?: string
}

export type PreviousRunVerdict = 'none' | 'running' | 'clean-exit' | 'hard-kill'

// Windows reports process creation times at a coarser granularity than the ISO
// string we persist, so an exact match is too strict.
const startTimeToleranceMs = 1_000

export const classifyPreviousRun = (
  sentinel: RunSentinel | null,
  probe: ProcessProbe,
): PreviousRunVerdict => {
  if (!sentinel) {
    return 'none'
  }

  if (sentinel.cleanExit) {
    return 'clean-exit'
  }

  if (!probe.alive) {
    return 'hard-kill'
  }

  if (!probe.startedAtIso) {
    return 'hard-kill'
  }

  const recorded = Date.parse(sentinel.startedAtIso)
  const observed = Date.parse(probe.startedAtIso)
  if (!Number.isFinite(recorded) || !Number.isFinite(observed)) {
    return 'hard-kill'
  }

  const sameProcess = Math.abs(observed - recorded) <= startTimeToleranceMs
  return sameProcess ? 'running' : 'hard-kill'
}

export const serializeRunSentinel = (record: RunSentinel): string =>
  JSON.stringify(record, null, 2)

// Deliberately total: the watchdog polls this file while the app is rewriting
// it, so a half-written or corrupt read must degrade to "nothing to recover"
// rather than throw. A throw in the watchdog costs us the recovery entirely,
// whereas a missed sentinel only costs one relaunch.
export const parseRunSentinel = (text: string): RunSentinel | null => {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }

  const { pid, startedAtIso, cleanExit } = raw as Record<string, unknown>
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return null
  }
  if (typeof startedAtIso !== 'string' || !Number.isFinite(Date.parse(startedAtIso))) {
    return null
  }
  if (typeof cleanExit !== 'boolean') {
    return null
  }

  return { pid, startedAtIso, cleanExit }
}

export type RelaunchLimits = {
  maxRelaunches?: number
  windowMs?: number
}

const defaultMaxRelaunches = 3
const defaultWindowMs = 10 * 60 * 1000

export const shouldRelaunch = (
  relaunchHistoryMs: readonly number[],
  nowMs: number,
  { maxRelaunches = defaultMaxRelaunches, windowMs = defaultWindowMs }: RelaunchLimits = {},
): boolean => {
  const recent = relaunchHistoryMs.filter((at) => nowMs - at < windowMs)
  return recent.length < maxRelaunches
}
