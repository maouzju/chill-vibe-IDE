import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  copyWorkspaceFileToClipboard,
  type ClipboardCopyInvocation,
} from '../server/file-system.js'

const createWorkspace = async () => mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-clipboard-'))

const createRecordingRunner = (result: { exitCode: number; stderr: string } = { exitCode: 0, stderr: '' }) => {
  const calls: ClipboardCopyInvocation[] = []
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args })
    return result
  }

  return { calls, run }
}

test('copyWorkspaceFileToClipboard rejects path traversal without touching the runner', async () => {
  const workspace = path.resolve('/projects/my-app')
  const { calls, run } = createRecordingRunner()

  await assert.rejects(
    copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: '../../etc/passwd' },
      { platform: 'win32', run },
    ),
    /Path traversal is not allowed/,
  )
  assert.equal(calls.length, 0)
})

test('copyWorkspaceFileToClipboard rejects missing files', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const { calls, run } = createRecordingRunner()

  await assert.rejects(
    copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: 'missing.md' },
      { platform: 'win32', run },
    ),
  )
  assert.equal(calls.length, 0)
})

test('copyWorkspaceFileToClipboard rejects directories', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await mkdir(path.join(workspace, 'reports'), { recursive: true })
  const { calls, run } = createRecordingRunner()

  await assert.rejects(
    copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: 'reports' },
      { platform: 'win32', run },
    ),
    /not a file/i,
  )
  assert.equal(calls.length, 0)
})

test('copyWorkspaceFileToClipboard uses Windows PowerShell Set-Clipboard with escaped literal path', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  // Single quote in the file name exercises PowerShell quoting ('' escape).
  const fileName = "review'report.md"
  await writeFile(path.join(workspace, fileName), '# report\n', 'utf8')

  const { calls, run } = createRecordingRunner()
  await copyWorkspaceFileToClipboard(
    { workspacePath: workspace, relativePath: fileName },
    { platform: 'win32', run },
  )

  assert.equal(calls.length, 1)
  const [{ command, args }] = calls
  assert.match(command, /powershell(\.exe)?$/i)
  assert.equal(args.includes('-NoProfile'), true)
  const scriptArg = args[args.length - 1]
  assert.match(scriptArg, /Set-Clipboard -LiteralPath/)

  const resolvedPath = path.join(workspace, fileName)
  const escapedPath = resolvedPath.replace(/'/g, "''")
  assert.equal(scriptArg.includes(`'${escapedPath}'`), true)
})

test('copyWorkspaceFileToClipboard uses osascript on macOS with escaped POSIX path', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  // Windows filenames cannot contain quotes, so the backslash-heavy host path is
  // what exercises the AppleScript escaping here (quotes share the same escape line).
  const fileName = 'plain report.md'
  await writeFile(path.join(workspace, fileName), '# report\n', 'utf8')

  const { calls, run } = createRecordingRunner()
  await copyWorkspaceFileToClipboard(
    { workspacePath: workspace, relativePath: fileName },
    { platform: 'darwin', run },
  )

  assert.equal(calls.length, 1)
  const [{ command, args }] = calls
  assert.equal(command, 'osascript')
  assert.equal(args[0], '-e')
  assert.match(args[1], /set the clipboard to \(POSIX file "/)

  const resolvedPath = path.join(workspace, fileName)
  const escapedPath = resolvedPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  assert.equal(args[1].includes(`"${escapedPath}"`), true)
})

test('copyWorkspaceFileToClipboard rejects unsupported platforms', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'report.md'), '# report\n', 'utf8')
  const { calls, run } = createRecordingRunner()

  await assert.rejects(
    copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: 'report.md' },
      { platform: 'linux', run },
    ),
    /not supported/i,
  )
  assert.equal(calls.length, 0)
})

test('copyWorkspaceFileToClipboard surfaces runner failures with stderr detail', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  await writeFile(path.join(workspace, 'report.md'), '# report\n', 'utf8')
  const { run } = createRecordingRunner({ exitCode: 1, stderr: 'clipboard is busy' })

  await assert.rejects(
    copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: 'report.md' },
      { platform: 'win32', run },
    ),
    /clipboard is busy/,
  )
})
