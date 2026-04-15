import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
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
    assert.ok(result.error?.includes('No release asset found'))
    assert.equal(result.assetUrl, undefined)
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
