import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'

import {
  buildWindowsZipReplaceScript,
  classifyDownloadedAsset,
  downloadWithResume,
  encodePowerShellScriptUtf8Bom,
  isNewerVersion,
  parseVersionTag,
  selectPlatformAsset,
  parseReleaseResponse,
  resolveDownloadedAssetStrategy,
} from '../electron/updater-core.ts'
import {
  launchDetachedPowerShellScriptFile,
  resolveWindowsPowerShellPath,
} from '../electron/updater-launch.ts'

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

  test('tracks lingering app processes by executable path instead of only the main pid', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /Get-CimInstance\s+Win32_Process/)
    assert.match(script, /\$proc\.ExecutablePath/)
    assert.match(script, /-ExecutablePath \$executablePath/)
  })

  test('force-kills remaining app child processes from the same install path after timeout', () => {
    const script = buildWindowsZipReplaceScript(baseParams)
    assert.match(script, /App processes still running after/)
    assert.match(script, /\$matchingProcessIds/)
    assert.match(script, /foreach \(\$remainingId in \$matchingProcessIds\)/)
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

describe('encodePowerShellScriptUtf8Bom', () => {
  test('writes a BOM so Windows PowerShell preserves Chinese paths inside the script file', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows PowerShell script encoding only matters on win32.')
      return
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-updater-'))
    const outputPath = path.join(tempDir, 'captured.txt')
    const scriptPath = path.join(tempDir, 'apply-update.ps1')
    const script = [
      `$value = 'D:\\下载\\Chill Vibe IDE'`,
      `Set-Content -LiteralPath '${outputPath.replace(/\\/g, '\\\\')}' -Value $value -Encoding utf8`,
    ].join('\r\n')

    await writeFile(scriptPath, encodePowerShellScriptUtf8Bom(script))

    try {
      const result = spawnSync(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { encoding: 'utf8' },
      )

      assert.equal(result.status, 0, result.stderr || result.stdout)
      const captured = (await readFile(outputPath, 'utf8')).replace(/^\uFEFF/, '')
      assert.equal(captured, 'D:\\下载\\Chill Vibe IDE\r\n')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('downloadWithResume', () => {
  const withTempDir = async (run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-resume-'))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const response = (options: {
    status: number
    headers?: Record<string, string>
    body: AsyncIterable<Uint8Array> | null
  }) => ({
    ok: options.status >= 200 && options.status < 300,
    status: options.status,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    body: options.body,
  })

  const streamOf = (...values: string[]) =>
    (async function* () {
      for (const value of values) {
        yield Buffer.from(value, 'utf8')
      }
    })()

  const streamThatDies = (...values: string[]) =>
    (async function* () {
      for (const value of values) {
        yield Buffer.from(value, 'utf8')
      }
      throw new Error('socket hang up')
    })()

  // 症状: 进度条停在某个百分比再也不动，没有报错、没有重试，重开设置页也一样。
  // 根因: net.fetch 没有超时，一个静默断掉的 TCP 连接会让 reader.read() 永远挂起。
  test('gives up on a stalled connection instead of hanging forever', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 1,
          stallTimeoutMs: 60,
          fetchRange: async (_rangeStart, signal) =>
            response({
              status: 200,
              headers: { 'content-length': '11' },
              body: (async function* () {
                yield Buffer.from('hel', 'utf8')
                await new Promise((_resolve, reject) => {
                  signal.addEventListener('abort', () => reject(new Error('aborted')))
                })
              })(),
            }),
        }),
        /stall/i,
      )
    })
  })

  // 症状: 同上，进度条一动不动 —— 但这一次连一个字节都没到过。
  // 根因: 停滞看门狗原先只包住响应体。在被墙/代理挂死的链路上 fetch() 本身永远不 settle，
  //       看门狗根本没机会启动 (2026-08-22 实测: 直连 github.com 会 ECONNRESET 或
  //       建连超时，走代理时则可能静默挂起)。
  test('gives up when the connection never produces response headers', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 1,
          stallTimeoutMs: 60,
          fetchRange: (_rangeStart, signal) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        }),
        /stall/i,
      )
    })
  })

  test('resumes from the bytes already on disk after a dropped connection', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      const requestedRanges: number[] = []
      let attempt = 0

      const result = await downloadWithResume({
        destPath,
        maxAttempts: 3,
        retryDelayMs: () => 0,
        fetchRange: async (rangeStart) => {
          requestedRanges.push(rangeStart)
          attempt += 1

          if (attempt === 1) {
            return response({
              status: 200,
              headers: { 'content-length': '11' },
              body: streamThatDies('hello '),
            })
          }

          return response({
            status: 206,
            headers: { 'content-range': 'bytes 6-10/11', 'content-length': '5' },
            body: streamOf('world'),
          })
        },
      })

      assert.equal(result, destPath)
      assert.deepEqual(requestedRanges, [0, 6])
      assert.equal(await readFile(destPath, 'utf8'), 'hello world')
      assert.equal(existsSync(`${destPath}.part`), false)
    })
  })

  test('restarts from zero when the server ignores the Range request', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      let attempt = 0

      await downloadWithResume({
        destPath,
        maxAttempts: 3,
        retryDelayMs: () => 0,
        fetchRange: async () => {
          attempt += 1

          if (attempt === 1) {
            return response({
              status: 200,
              headers: { 'content-length': '11' },
              body: streamThatDies('hel'),
            })
          }

          // No 206 — a proxy that does not honour Range hands back the whole file.
          return response({
            status: 200,
            headers: { 'content-length': '11' },
            body: streamOf('hello world'),
          })
        },
      })

      assert.equal(await readFile(destPath, 'utf8'), 'hello world')
    })
  })

  test('reports progress against the full payload while resuming', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      const progress: number[] = []
      let attempt = 0

      await downloadWithResume({
        destPath,
        maxAttempts: 3,
        retryDelayMs: () => 0,
        onProgress: (percent) => progress.push(percent),
        fetchRange: async () => {
          attempt += 1

          if (attempt === 1) {
            return response({
              status: 200,
              headers: { 'content-length': '10' },
              body: streamThatDies('12345'),
            })
          }

          return response({
            status: 206,
            headers: { 'content-range': 'bytes 5-9/10', 'content-length': '5' },
            body: streamOf('67890'),
          })
        },
      })

      // The resumed half must continue at 50%, not restart the bar at 0%.
      assert.deepEqual(progress, [50, 100])
    })
  })

  test('keeps the partial file after exhausting retries so the next run can continue', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 2,
          retryDelayMs: () => 0,
          fetchRange: async (rangeStart) =>
            response({
              status: rangeStart > 0 ? 206 : 200,
              headers:
                rangeStart > 0
                  ? { 'content-range': `bytes ${rangeStart}-10/11` }
                  : { 'content-length': '11' },
              body: streamThatDies('ab'),
            }),
        }),
        /socket hang up/,
      )

      assert.equal(existsSync(destPath), false)
      assert.equal(await readFile(`${destPath}.part`, 'utf8'), 'abab')
    })
  })

  test('discards a partial file that is bigger than the advertised payload', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      await writeFile(`${destPath}.part`, 'this-leftover-is-way-too-long')

      await downloadWithResume({
        destPath,
        maxAttempts: 2,
        retryDelayMs: () => 0,
        fetchRange: async () =>
          response({
            status: 200,
            headers: { 'content-length': '11' },
            body: streamOf('hello world'),
          }),
      })

      assert.equal(await readFile(destPath, 'utf8'), 'hello world')
    })
  })

  // 症状: 更新后应用打不开 —— 安装脚本收到的是一个只含尾段的 zip，而下载这一侧
  //       报告「校验通过」。
  // 根因: 完整性判据用的是内存里的 `received` 计数器。当服务器回 206 但 Content-Range
  //       无法解析（代理改写/丢头）时，续传对不上 → 截断重写，可 totalBytes 取的却是
  //       206 响应的 Content-Length（只有剩余那一段的长度），于是 received === totalBytes
  //       恰好成立，一个残缺档案就被 rename 成了正式包。
  test('never publishes a partial body as a whole archive when the resume offset cannot be lined up', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      await writeFile(`${destPath}.part`, 'hello ')

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 1,
          retryDelayMs: () => 0,
          fetchRange: async () =>
            response({
              status: 206,
              // A proxy dropped Content-Range; the body is only the tail.
              headers: { 'content-length': '5' },
              body: streamOf('world'),
            }),
        }),
      )

      assert.equal(existsSync(destPath), false)
    })
  })

  // 根因: 停滞时我们最多只等 2s 让上一轮的 reader 收尾，而这次修复的前提正是
  //       「reader 可能不理会 abort」。一个事后苏醒的 reader 会继续往同一个 .part
  //       追加，与新一轮的句柄交错 —— 磁盘上多出来的字节，内存计数器永远看不见。
  test('refuses to publish when the bytes on disk disagree with the counted bytes', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      const partPath = `${destPath}.part`

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 1,
          retryDelayMs: () => 0,
          fetchRange: async () =>
            response({
              status: 200,
              headers: { 'content-length': '11' },
              body: (async function* () {
                yield Buffer.from('hello world', 'utf8')
                // A zombie reader from a previous attempt lands three extra bytes.
                await appendFile(partPath, 'XXX')
              })(),
            }),
        }),
        /disk|incomplete/i,
      )

      assert.equal(existsSync(destPath), false)
    })
  })

  test('a rejected resume offset does not burn a retry attempt', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      await writeFile(`${destPath}.part`, 'stale-leftover-from-another-asset')
      let calls = 0

      await downloadWithResume({
        destPath,
        maxAttempts: 1,
        retryDelayMs: () => 0,
        fetchRange: async () => {
          calls += 1

          if (calls === 1) {
            return response({ status: 416, body: null })
          }

          return response({
            status: 200,
            headers: { 'content-length': '11' },
            body: streamOf('hello world'),
          })
        },
      })

      // maxAttempts is 1, yet the 416 reset must not consume it: clearing a stale
      // .part is bookkeeping, not a failed download attempt.
      assert.equal(calls, 2)
      assert.equal(await readFile(destPath, 'utf8'), 'hello world')
    })
  })

  test('does not retry a hard HTTP error', async () => {
    await withTempDir(async (dir) => {
      const destPath = path.join(dir, 'update.zip')
      let calls = 0

      await assert.rejects(
        downloadWithResume({
          destPath,
          maxAttempts: 4,
          retryDelayMs: () => 0,
          fetchRange: async () => {
            calls += 1
            return response({ status: 404, body: null })
          },
        }),
        /404/,
      )

      assert.equal(calls, 1)
    })
  })
})

describe('windows zip update job — end-to-end PowerShell run', () => {
  // 症状: 用户报告更新后应用打不开/版本没变 —— "在没有解压完全的情况下重启应用"。
  // 根因: 脚本先清空安装目录再复制，中间没有任何完整性闸门，Find-AppRoot 的
  //       fallback 分支还会接受一个没有 resources/ 的残缺目录当作 app 根。
  // 这两个测试直接跑真实 PowerShell，因为纯字符串断言无法证明脚本的实际破坏行为。
  const FAKE_EXE_NAME = 'fake-app.cmd'
  const psQuote = (value: string) => value.replace(/'/g, "''")

  const runPowerShellCommand = (command: string) =>
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      timeout: 120_000,
    })

  const runPowerShellScriptFile = (scriptPath: string) =>
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 120_000,
    })

  const waitForFile = async (filePath: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(filePath)) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return existsSync(filePath)
  }

  // Windows-only fault injection helpers.
  //
  // `fs.open()` is NOT usable to make Move-Item fail: libuv opens files with
  // FILE_SHARE_READ|WRITE|DELETE, so a Node handle blocks nothing (2026-08-16 probe:
  // "DELETE OK" while the handle was open). A process whose *current directory* is the
  // item does block both rename and delete, which is what `holdDirectoryOpen` uses.
  const holdDirectoryOpen = async (dir: string) => {
    await mkdir(dir, { recursive: true })
    // The cwd lock is taken by CreateProcess itself, so it exists the moment spawn returns.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 180000)'], {
      cwd: dir,
      stdio: 'ignore',
    })
    await new Promise((resolve) => setTimeout(resolve, 250))

    return async () => {
      child.kill()
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }

  // A real AV/indexer handle is transient: it blocks the swap and is gone again by the
  // time the rollback runs. That timing cannot be reproduced with a real lock (releasing
  // it is a race against the script), so the transient case is injected by shadowing
  // Move-Item with a proxy function — the script's own control flow (the `$backupCreated`
  // flag, the catch branch, the rollback) still runs for real.
  const writeMoveFaultWrapper = async (
    lab: { root: string; scriptPath: string },
    options: { failSwapOnLeaf: string; failRestore?: boolean },
  ) => {
    const wrapperPath = path.join(lab.root, 'move-fault-wrapper.ps1')
    const wrapper = [
      `$ErrorActionPreference = 'Continue'`,
      `$global:cvSwapFailed = $false`,
      `$global:cvRestoreFailed = $false`,
      `function Move-Item {`,
      `  [CmdletBinding()]`,
      `  param(`,
      `    [Parameter(Mandatory = $true, ValueFromPipelineByPropertyName = $true)]`,
      `    [Alias('PSPath')]`,
      `    [string]$LiteralPath,`,
      `    [Parameter(Position = 0)]`,
      `    [string]$Destination,`,
      `    [switch]$Force`,
      `  )`,
      `  process {`,
      `    $isSwap = $Destination -like '*chill-vibe-backup*'`,
      `    if ($isSwap -and (-not $global:cvSwapFailed) -and ($LiteralPath -like '*${options.failSwapOnLeaf}')) {`,
      `      $global:cvSwapFailed = $true`,
      `      throw "The process cannot access the file '$LiteralPath' because it is being used by another process."`,
      `    }`,
      `    if ((-not $isSwap) -and ${options.failRestore ? '$true' : '$false'} -and (-not $global:cvRestoreFailed)) {`,
      `      $global:cvRestoreFailed = $true`,
      `      throw "Access to the path '$LiteralPath' is denied."`,
      `    }`,
      `    Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force`,
      `  }`,
      `}`,
      `& '${psQuote(lab.scriptPath)}'`,
    ].join('\r\n')

    await writeFile(wrapperPath, encodePowerShellScriptUtf8Bom(wrapper))
    return wrapperPath
  }

  // Write-Log goes through Out-File, which wraps long lines at the host width, so
  // path assertions have to ignore the injected line breaks.
  const flattenLog = (value: string) => value.replace(/\s+/g, '')

  // 每条用例都得走这个，别在收尾里直接写裸 `rm`。
  //
  // 症状：2026-08-16 发布闸门里 "replaces the install and launches the app when the
  //   payload is complete" 红在收尾的 `EBUSY: resource busy or locked, rmdir ...\installed`
  //   —— 断言全过了，炸的是清理。单跑绿、满清单跑红。
  // 根因：这些用例真的起了子进程又杀掉，而 Windows 上"进程退出"与"它对 cwd 的句柄
  //   被释放"不是同一时刻；满清单并发下这个窗口被拉长到足以撞上 rmdir。
  // 为什么不是固定 sleep：等多久都是猜，而重试是等到真的能删为止。
  const removeLabRoot = (root: string) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

  const createUpdateJobLab = async ({
    completePayload,
    stuckFileName,
    stuckDirName,
  }: {
    completePayload: boolean
    stuckFileName?: string
    stuckDirName?: string
  }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-update-job-'))
    const payloadRoot = path.join(root, 'payload', 'Chill Vibe IDE')
    const targetDir = path.join(root, 'installed')
    const launchLogPath = path.join(root, 'launched.log')
    const relaunchLogPath = path.join(root, 'relaunched.log')
    const executablePath = path.join(targetDir, FAKE_EXE_NAME)

    await mkdir(payloadRoot, { recursive: true })
    await writeFile(
      path.join(payloadRoot, FAKE_EXE_NAME),
      `@echo off\r\n>>"${launchLogPath}" echo launched\r\n`,
    )

    if (completePayload) {
      await mkdir(path.join(payloadRoot, 'resources'), { recursive: true })
      await writeFile(path.join(payloadRoot, 'resources', 'app.asar'), 'new-app-asar-payload')
      await mkdir(path.join(payloadRoot, 'locales'), { recursive: true })
      await writeFile(path.join(payloadRoot, 'locales', 'en-US.pak'), 'pak')
    }

    const assetPath = path.join(root, 'update.zip')
    const compressed = runPowerShellCommand(
      `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath '${psQuote(payloadRoot)}' -DestinationPath '${psQuote(assetPath)}' -Force`,
    )
    assert.equal(compressed.status, 0, compressed.stderr || compressed.stdout)

    // A real install that must not be destroyed unless the payload is trustworthy.
    await mkdir(path.join(targetDir, 'resources'), { recursive: true })
    // Writes to a *different* log than the payload copy, so a rollback relaunch can be
    // told apart from a successful update launch.
    await writeFile(
      path.join(targetDir, FAKE_EXE_NAME),
      `@echo off\r\n>>"${relaunchLogPath}" echo relaunched\r\n`,
    )
    await writeFile(path.join(targetDir, 'resources', 'app.asar'), 'old-app-asar-payload')
    await writeFile(path.join(targetDir, 'sentinel.txt'), 'previous-install')

    if (stuckFileName) {
      await writeFile(path.join(targetDir, stuckFileName), 'stuck-decoy')
    }

    if (stuckDirName) {
      await mkdir(path.join(targetDir, stuckDirName), { recursive: true })
    }

    const stagingDir = path.join(root, 'extract')
    const logPath = path.join(root, 'apply-update.log')
    const scriptPath = path.join(root, 'apply-update.ps1')

    await writeFile(logPath, '')
    await writeFile(
      scriptPath,
      encodePowerShellScriptUtf8Bom(
        buildWindowsZipReplaceScript({
          // A PID that cannot exist, so the wait loop exits immediately instead of
          // force-killing the test runner.
          processId: 0x7ffffffe,
          assetPath,
          targetDir,
          executablePath,
          stagingDir,
          logPath,
          waitTimeoutSeconds: 2,
        }),
      ),
    )

    return {
      root,
      targetDir,
      backupDir: `${targetDir}.chill-vibe-backup`,
      launchLogPath,
      relaunchLogPath,
      logPath,
      scriptPath,
    }
  }

  test('refuses to wipe the installed app when the extracted payload is incomplete', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('The Windows zip update job only runs on win32.')
      return
    }

    const lab = await createUpdateJobLab({ completePayload: false })

    try {
      const result = runPowerShellScriptFile(lab.scriptPath)
      const jobLog = await readFile(lab.logPath, 'utf8')
      const launched = await waitForFile(lab.launchLogPath, 3_000)

      assert.equal(
        existsSync(path.join(lab.targetDir, 'sentinel.txt')),
        true,
        `The previous install was destroyed by an incomplete payload.\n${jobLog}`,
      )
      assert.equal(
        await readFile(path.join(lab.targetDir, 'resources', 'app.asar'), 'utf8'),
        'old-app-asar-payload',
        `The previous app.asar was replaced from an incomplete payload.\n${jobLog}`,
      )
      assert.equal(launched, false, `A broken install was launched.\n${jobLog}`)
      assert.notEqual(result.status, 0, `Job reported success for an incomplete payload.\n${jobLog}`)
      assert.match(jobLog, /incomplete|missing/i)
    } finally {
      await removeLabRoot(lab.root)
    }
  })

  test('replaces the install and launches the app when the payload is complete', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('The Windows zip update job only runs on win32.')
      return
    }

    const lab = await createUpdateJobLab({ completePayload: true })

    try {
      const result = runPowerShellScriptFile(lab.scriptPath)
      const jobLog = await readFile(lab.logPath, 'utf8')

      assert.equal(result.status, 0, `${jobLog}\n${result.stderr}`)
      assert.equal(
        existsSync(path.join(lab.targetDir, 'sentinel.txt')),
        false,
        `Stale files from the old install survived the replace.\n${jobLog}`,
      )
      assert.equal(
        await readFile(path.join(lab.targetDir, 'resources', 'app.asar'), 'utf8'),
        'new-app-asar-payload',
        `The new payload did not land in the install directory.\n${jobLog}`,
      )
      assert.equal(
        await waitForFile(lab.launchLogPath, 20_000),
        true,
        `The updated app was never launched.\n${jobLog}`,
      )
    } finally {
      await removeLabRoot(lab.root)
    }
  })

  // 症状: 更新失败后安装目录只剩一半文件，应用彻底打不开，日志里没有任何回滚记录。
  // 根因: `$backupCreated = $true` 写在 Move-Item 管道之后。管道跑在
  //       $ErrorActionPreference='Stop' 下，中途一个被占用的文件就会终止整条管道 ——
  //       此时一部分文件已在备份目录、一部分还在安装目录，而标志位仍是 $false，
  //       catch 里的回滚分支被整个跳过。
  test('restores the previous install when the swap fails midway through Move-Item', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('The Windows zip update job only runs on win32.')
      return
    }

    const lab = await createUpdateJobLab({
      completePayload: true,
      // Sorts last, so `resources`, the exe, and `sentinel.txt` are already parked in the
      // backup folder when the pipeline dies — a genuinely half-swapped install.
      stuckFileName: 'zz-stuck.bin',
    })

    try {
      const wrapperPath = await writeMoveFaultWrapper(lab, { failSwapOnLeaf: 'zz-stuck.bin' })
      const result = runPowerShellScriptFile(wrapperPath)
      const jobLog = await readFile(lab.logPath, 'utf8')

      assert.notEqual(result.status, 0, `A failed swap must not report success.\n${jobLog}`)
      assert.match(jobLog, /Rolling back/i)

      assert.equal(
        existsSync(path.join(lab.targetDir, 'sentinel.txt')),
        true,
        `The half-swapped install was never rolled back.\n${jobLog}`,
      )
      assert.equal(
        await readFile(path.join(lab.targetDir, 'sentinel.txt'), 'utf8'),
        'previous-install',
        `Rollback restored the wrong sentinel content.\n${jobLog}`,
      )
      assert.equal(
        await readFile(path.join(lab.targetDir, 'resources', 'app.asar'), 'utf8'),
        'old-app-asar-payload',
        `The previous app.asar was not restored.\n${jobLog}`,
      )
      assert.equal(
        existsSync(path.join(lab.targetDir, FAKE_EXE_NAME)),
        true,
        `The previous executable was not restored.\n${jobLog}`,
      )
      assert.equal(
        existsSync(lab.backupDir),
        false,
        `A completed rollback must not leave the backup folder behind.\n${jobLog}`,
      )
      assert.equal(
        await waitForFile(lab.relaunchLogPath, 20_000),
        true,
        `The rolled-back install was never relaunched.\n${jobLog}`,
      )
      assert.equal(
        existsSync(lab.launchLogPath),
        false,
        `The half-installed new build must never be launched.\n${jobLog}`,
      )
    } finally {
      await removeLabRoot(lab.root)
    }
  })

  // 症状: 一次更新失败后，之后每一次更新都在动到安装目录之前就报错，用户只看到一句
  //       关于备份目录的报错，完全不知道要删什么。
  // 根因: 成功路径用 -ErrorAction SilentlyContinue 删备份目录，被占用时会永久留下
  //       <install>.chill-vibe-backup；下一次更新开头的 Remove-Item 没有任何保护、
  //       跑在 Stop 下，于是陈旧备份把后续更新全部锁死。
  test('keeps updating when a stale backup folder from an earlier run cannot be deleted', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('The Windows zip update job only runs on win32.')
      return
    }

    const lab = await createUpdateJobLab({ completePayload: true })
    const releaseLock = await holdDirectoryOpen(path.join(lab.backupDir, 'locked-leftover'))

    try {
      const result = runPowerShellScriptFile(lab.scriptPath)
      const jobLog = await readFile(lab.logPath, 'utf8')

      assert.equal(
        result.status,
        0,
        `A stale backup folder must not block every future update.\n${jobLog}\n${result.stderr}`,
      )
      assert.equal(
        await readFile(path.join(lab.targetDir, 'resources', 'app.asar'), 'utf8'),
        'new-app-asar-payload',
        `The update never reached the install directory.\n${jobLog}`,
      )
      assert.equal(
        existsSync(path.join(lab.targetDir, 'sentinel.txt')),
        false,
        `Stale files from the old install survived the replace.\n${jobLog}`,
      )
      // The stale folder is still there — the log has to name it so support can tell the
      // user exactly what to delete.
      assert.ok(
        flattenLog(jobLog).includes(flattenLog(lab.backupDir)),
        `The log never names the stale backup folder.\n${jobLog}`,
      )
      assert.equal(
        await waitForFile(lab.launchLogPath, 20_000),
        true,
        `The updated app was never launched.\n${jobLog}`,
      )
    } finally {
      await releaseLock()
      await removeLabRoot(lab.root)
    }
  })

  // 症状: 回滚自己也失败时应用已经退出，日志里只有一句 "Rollback failed"，
  //       没人知道文件去了哪里，支持人员也没法指导用户手工恢复。
  // 根因: 内层 catch 只写了异常消息，没有写出备份目录的绝对路径。
  test('logs the backup folder path for manual recovery when the rollback itself fails', async (t) => {
    if (process.platform !== 'win32') {
      t.skip('The Windows zip update job only runs on win32.')
      return
    }

    const lab = await createUpdateJobLab({
      completePayload: true,
      stuckFileName: 'zz-stuck.bin',
    })

    try {
      const wrapperPath = await writeMoveFaultWrapper(lab, {
        failSwapOnLeaf: 'zz-stuck.bin',
        failRestore: true,
      })
      const result = runPowerShellScriptFile(wrapperPath)
      const jobLog = await readFile(lab.logPath, 'utf8')

      assert.notEqual(result.status, 0, `A failed rollback must not report success.\n${jobLog}`)
      assert.match(jobLog, /Rollback failed/i)
      assert.match(
        jobLog,
        /Manual recovery/i,
        `A failed rollback must leave a manual recovery hint.\n${jobLog}`,
      )
      assert.ok(
        flattenLog(jobLog).includes(flattenLog(lab.backupDir)),
        `A failed rollback must log the absolute backup folder path.\n${jobLog}`,
      )
      assert.ok(
        flattenLog(jobLog).includes(flattenLog(lab.targetDir)),
        `A failed rollback must log where the files have to be restored to.\n${jobLog}`,
      )
      assert.equal(
        existsSync(lab.backupDir),
        true,
        `The files the user has to recover must still be on disk.\n${jobLog}`,
      )
    } finally {
      await removeLabRoot(lab.root)
    }
  })
})

describe('resolveWindowsPowerShellPath', () => {
  test('prefers the absolute SystemRoot PowerShell path when it exists', () => {
    const resolved = resolveWindowsPowerShellPath(
      {
        PATH: '',
        SystemRoot: 'C:\\Windows',
      },
      (candidatePath) =>
        candidatePath === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )

    assert.equal(resolved, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  test('falls back to bare powershell.exe when the standard path is unavailable', () => {
    const resolved = resolveWindowsPowerShellPath(
      {
        PATH: '',
        SystemRoot: 'C:\\MissingWindows',
      },
      () => false,
    )

    assert.equal(resolved, 'powershell.exe')
  })
})

describe('launchDetachedPowerShellScriptFile', () => {
  class FakeChildProcess extends EventEmitter {
    unrefCalls = 0

    unref() {
      this.unrefCalls += 1
    }
  }

  test('launches the detached updater job from an absolute PowerShell path and waits for spawn', async () => {
    const child = new FakeChildProcess()
    let capturedCommand = ''
    let capturedArgs: string[] = []
    let capturedOptions:
      | {
          detached: boolean
          stdio: 'ignore'
          windowsHide: boolean
        }
      | undefined

    await launchDetachedPowerShellScriptFile({
      scriptPath: 'C:\\Temp\\apply-update.ps1',
      env: {
        PATH: '',
        SystemRoot: 'C:\\Windows',
      },
      fileExists: () => true,
      spawnProcess: (command, args, options) => {
        capturedCommand = command
        capturedArgs = args
        capturedOptions = options
        setImmediate(() => child.emit('spawn'))
        return child
      },
    })

    // Must wrap PowerShell under cmd.exe /c start /B because Node's spawn
    // with { detached:true, windowsHide:true } against powershell.exe directly
    // causes PS to exit 0 immediately without running the script on Windows.
    assert.equal(capturedCommand, 'cmd.exe')
    assert.deepEqual(capturedArgs, [
      '/c',
      'start',
      '""',
      '/B',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Temp\\apply-update.ps1',
    ])
    // stdio must be 'ignore' — inheriting fds caused fd lifecycle bugs and
    // doesn't help once we detach through cmd.exe anyway.
    assert.deepEqual(capturedOptions, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    assert.equal(child.unrefCalls, 1)
  })

  test('rejects before quit if spawning the PowerShell job fails', async () => {
    const child = new FakeChildProcess()

    await assert.rejects(
      launchDetachedPowerShellScriptFile({
        scriptPath: 'C:\\Temp\\apply-update.ps1',
        env: {
          PATH: '',
        },
        fileExists: () => false,
        spawnProcess: () => {
          setImmediate(() => child.emit('error', new Error('spawn ENOENT')))
          return child
        },
      }),
      /spawn ENOENT/,
    )

    assert.equal(child.unrefCalls, 0)
  })
})
