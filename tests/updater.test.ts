import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildWindowsZipReplaceScript,
  classifyDownloadedAsset,
  isNewerVersion,
  parseVersionTag,
  selectPlatformAsset,
  parseReleaseResponse,
  resolveDownloadedAssetStrategy,
} from '../electron/updater-core.ts'

describe('parseVersionTag', () => {
  test('strips v prefix', () => {
    assert.equal(parseVersionTag('v0.2.0'), '0.2.0')
  })

  test('passes through bare version', () => {
    assert.equal(parseVersionTag('0.2.0'), '0.2.0')
  })

  test('rejects invalid tag', () => {
    assert.equal(parseVersionTag('vbeta'), null)
  })

  test('rejects partial version', () => {
    assert.equal(parseVersionTag('v1.2'), null)
  })

  test('rejects empty string', () => {
    assert.equal(parseVersionTag(''), null)
  })
})

describe('isNewerVersion', () => {
  test('newer patch', () => {
    assert.equal(isNewerVersion('0.1.1', '0.1.0'), true)
  })

  test('newer minor', () => {
    assert.equal(isNewerVersion('0.2.0', '0.1.0'), true)
  })

  test('newer major', () => {
    assert.equal(isNewerVersion('1.0.0', '0.99.99'), true)
  })

  test('same version', () => {
    assert.equal(isNewerVersion('0.1.0', '0.1.0'), false)
  })

  test('older version', () => {
    assert.equal(isNewerVersion('0.0.9', '0.1.0'), false)
  })

  test('older major with higher minor', () => {
    assert.equal(isNewerVersion('0.99.0', '1.0.0'), false)
  })
})

describe('selectPlatformAsset', () => {
  const assets = [
    { name: 'Chill-Vibe-0.2.0-win.zip', browser_download_url: 'https://example.com/update.zip' },
    { name: 'Chill-Vibe-Setup-0.2.0.exe', browser_download_url: 'https://example.com/setup.exe' },
    { name: 'Chill-Vibe-0.2.0.dmg', browser_download_url: 'https://example.com/setup.dmg' },
    { name: 'release-notes.txt', browser_download_url: 'https://example.com/notes.txt' },
  ]

  test('prefers zip payloads for win32', () => {
    const result = selectPlatformAsset(assets, 'win32')
    assert.equal(result?.name, 'Chill-Vibe-0.2.0-win.zip')
  })

  test('selects dmg for darwin', () => {
    const result = selectPlatformAsset(assets, 'darwin')
    assert.equal(result?.name, 'Chill-Vibe-0.2.0.dmg')
  })

  test('returns null for linux', () => {
    const result = selectPlatformAsset(assets, 'linux')
    assert.equal(result, null)
  })

  test('returns null for empty assets', () => {
    const result = selectPlatformAsset([], 'win32')
    assert.equal(result, null)
  })
})

describe('parseReleaseResponse', () => {
  const makeRelease = (tag: string, assetNames: string[] = []) => ({
    tag_name: tag,
    body: 'Release notes here',
    html_url: 'https://github.com/maouzju/chill-vibe-IDE/releases/tag/' + tag,
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: `https://github.com/download/${name}`,
    })),
  })

  test('detects newer version with matching asset', () => {
    const release = makeRelease('v0.2.0', [
      'Chill-Vibe-0.2.0-win.zip',
      'Chill-Vibe-Setup-0.2.0.exe',
      'Chill-Vibe-0.2.0.dmg',
    ])
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.equal(result.hasUpdate, true)
    assert.equal(result.latestVersion, '0.2.0')
    assert.equal(result.currentVersion, '0.1.0')
    assert.ok(result.assetUrl?.endsWith('.zip'))
    assert.equal(result.releaseNotes, 'Release notes here')
    assert.equal(result.error, undefined)
  })

  test('detects no update for same version', () => {
    const release = makeRelease('v0.1.0', ['setup.exe'])
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.equal(result.hasUpdate, false)
    assert.equal(result.latestVersion, '0.1.0')
  })

  test('reports error for invalid tag', () => {
    const release = makeRelease('invalid-tag', ['setup.exe'])
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.equal(result.hasUpdate, false)
    assert.ok(result.error?.includes('Invalid release tag'))
  })

  test('reports error when no asset matches platform', () => {
    const release = makeRelease('v0.2.0', ['setup.exe'])
    const result = parseReleaseResponse(release, '0.1.0', 'linux')

    assert.equal(result.hasUpdate, true)
    assert.equal(result.error, 'No downloadable Linux asset found in the latest release.')
    assert.equal(result.assetUrl, undefined)
  })

  test('reports missing release assets before blaming the platform', () => {
    const release = makeRelease('v0.2.0')
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.equal(result.hasUpdate, true)
    assert.equal(result.assetUrl, undefined)
    assert.equal(result.error, 'Latest release does not have any downloadable assets yet.')
  })

  test('uses a friendly platform label when a platform-specific asset is missing', () => {
    const release = makeRelease('v0.2.0', ['Chill-Vibe-0.2.0.dmg'])
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.equal(result.hasUpdate, true)
    assert.equal(result.assetUrl, undefined)
    assert.equal(result.error, 'No downloadable Windows asset found in the latest release.')
  })

  test('includes htmlUrl for release page navigation', () => {
    const release = makeRelease('v0.2.0', ['setup.exe'])
    const result = parseReleaseResponse(release, '0.1.0', 'win32')

    assert.ok(result.htmlUrl?.includes('v0.2.0'))
  })
})

describe('update asset install strategy', () => {
  test('classifies win32 zip payloads for folder replacement', () => {
    assert.equal(classifyDownloadedAsset('D:/Downloads/Chill-Vibe-0.2.0-win.zip'), 'zip')
    assert.equal(
      resolveDownloadedAssetStrategy('win32', 'D:/Downloads/Chill-Vibe-0.2.0-win.zip'),
      'replace-app-folder',
    )
  })

  test('keeps installer payloads on shell-open fallback', () => {
    assert.equal(classifyDownloadedAsset('D:/Downloads/Chill-Vibe-Setup-0.2.0.exe'), 'installer')
    assert.equal(
      resolveDownloadedAssetStrategy('win32', 'D:/Downloads/Chill-Vibe-Setup-0.2.0.exe'),
      'shell-open',
    )
  })

  test('uses shell-open fallback for disk images', () => {
    assert.equal(classifyDownloadedAsset('/tmp/Chill-Vibe-0.2.0.dmg'), 'disk-image')
    assert.equal(
      resolveDownloadedAssetStrategy('darwin', '/tmp/Chill-Vibe-0.2.0.dmg'),
      'shell-open',
    )
  })
})

describe('buildWindowsZipReplaceScript', () => {
  const baseParams = {
    processId: 12345,
    assetPath: 'C:\\Temp\\Chill.Vibe-0.14.0-win.zip',
    targetDir: 'D:\\下载\\Chill.Vibe',
    executablePath: 'D:\\下载\\Chill.Vibe\\Chill Vibe.exe',
    stagingDir: 'C:\\Temp\\chill-vibe-update-1\\extract',
    logPath: 'C:\\Temp\\chill-vibe-update-1\\apply-update.log',
    waitTimeoutSeconds: 30,
  }

  test('waits for the parent PID but bounded by a timeout', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /\$pidToWait = 12345/)
    assert.match(script, /\$waitTimeoutSeconds = 30/)
    // Must stop waiting after the timeout elapses (force-kill the parent so we can proceed)
    assert.match(script, /Stop-Process[^\n]*-Force/)
  })

  test('force-kills the parent if it lingers past the timeout', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    // The wait loop must exit when elapsed crosses the timeout (guard against infinite wait)
    assert.match(script, /\$elapsed[^\n]*-ge[^\n]*\$TimeoutSeconds/)
  })

  test('measures the wait timeout in real time instead of half-second loop counts', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /Start-Sleep -Milliseconds 500/)
    assert.match(script, /\$elapsedMilliseconds[^\n]*\+= 500/)
    assert.match(script, /\$elapsedMilliseconds[^\n]*-ge[^\n]*\(\$TimeoutSeconds \* 1000\)/)
  })

  test('writes a log file for every major phase', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /\$logPath = 'C:\\Temp\\chill-vibe-update-1\\apply-update\.log'/)
    // Each phase should append to the log (Out-File -Append or Add-Content)
    assert.match(script, /(Out-File|Add-Content)[^\n]*\$logPath/)
    // Must log the expand, copy, and launch phases so we can diagnose silent failures
    assert.match(script, /expand/i)
    assert.match(script, /copy/i)
    assert.match(script, /launch/i)
  })

  test('wraps the body in try/catch so failures are logged instead of swallowed', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /\btry\s*\{/)
    assert.match(script, /\bcatch\s*\{/)
  })

  test('escapes single quotes inside paths to avoid PowerShell injection', () => {
    const script = buildWindowsZipReplaceScript({
      ...baseParams,
      targetDir: "D:\\My'Dir\\Chill",
    })
    // PowerShell single-quote escape: ' -> ''
    assert.match(script, /D:\\My''Dir\\Chill/)
  })

  test('uses UTF-8 output encoding so Chinese paths survive the shell roundtrip', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /UTF8Encoding/)
  })
})
