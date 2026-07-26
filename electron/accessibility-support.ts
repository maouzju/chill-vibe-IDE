import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const accessibilitySupportFlagFileName = 'accessibility-support.json'

const optInValue = '1'
const byteOrderMark = 0xfeff

/**
 * Chromium command-line switches must be appended before `app.whenReady()`, so
 * this resolves from cheap inputs only — never from the full persisted state.
 */
export function resolveAccessibilitySupportEnabled({
  enableOverride,
  disableOverride,
  persistedFlag,
}: {
  enableOverride?: string | null
  disableOverride?: string | null
  persistedFlag?: boolean | null
} = {}) {
  // Disable wins so support triage can always turn the extra a11y tree off,
  // even on a profile that persisted it as enabled.
  if (disableOverride === optInValue) {
    return false
  }

  if (enableOverride === optInValue) {
    return true
  }

  return persistedFlag === true
}

const resolveFlagPath = (dataDir: string) => path.join(dataDir, accessibilitySupportFlagFileName)

/**
 * Returns `null` for any missing, unreadable, or malformed sidecar so a corrupt
 * file degrades to the default instead of blocking startup.
 */
export function readAccessibilitySupportFlag(dataDir: string): boolean | null {
  try {
    const raw = readFileSync(resolveFlagPath(dataDir), 'utf8')
    // Windows PowerShell writes a BOM with `-Encoding utf8` and JSON.parse
    // rejects it (pitfall #95), so a hand-edited file must still be readable.
    const body = raw.charCodeAt(0) === byteOrderMark ? raw.slice(1) : raw
    const parsed = JSON.parse(body) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    const enabled = (parsed as { enabled?: unknown }).enabled
    return typeof enabled === 'boolean' ? enabled : null
  } catch {
    return null
  }
}

export function writeAccessibilitySupportFlag(dataDir: string, enabled: boolean) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(resolveFlagPath(dataDir), `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}
