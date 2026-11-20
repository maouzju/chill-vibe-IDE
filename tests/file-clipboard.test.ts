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

// 按 PowerShell 分词器规则解析单引号字符串：U+0027 与 U+2018~U+201B 都是单引号定界符，
// 两个连续的单引号类字符表示一个字面量。返回字面量内容与字符串结束后的剩余文本。
const parsePowerShellSingleQuoted = (script: string) => {
  const isSingleQuote = (char: string | undefined) =>
    char !== undefined && /['‘’‚‛]/.test(char)
  assert.equal(isSingleQuote(script[0]), true)
  let value = ''
  let index = 1
  while (index < script.length) {
    const char = script[index]
    if (isSingleQuote(char)) {
      if (!isSingleQuote(script[index + 1])) {
        return { value, rest: script.slice(index + 1) }
      }
      value += script[index + 1]
      index += 2
      continue
    }
    value += char
    index += 1
  }
  throw new Error('unterminated PowerShell string')
}

// 2026-11-20 审查：只转义 ASCII 单引号时，文件名里的弯引号会提前结束字符串并注入命令。
test('copyWorkspaceFileToClipboard keeps typographic quotes in the file name inside the PowerShell literal', async (t) => {
  const workspace = await createWorkspace()
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  const fileNames = [
    'it’s.txt',
    'a’;Start-Process calc;’.txt',
    'b‘;x;‚;y;‛.txt',
  ]

  for (const fileName of fileNames) {
    await writeFile(path.join(workspace, fileName), 'x', 'utf8')
    const { calls, run } = createRecordingRunner()
    await copyWorkspaceFileToClipboard(
      { workspacePath: workspace, relativePath: fileName },
      { platform: 'win32', run },
    )

    const scriptArg = calls[0].args.at(-1) ?? ''
    const prefix = 'Set-Clipboard -LiteralPath '
    assert.equal(scriptArg.startsWith(prefix), true, scriptArg)
    const parsed = parsePowerShellSingleQuoted(scriptArg.slice(prefix.length))
    assert.equal(parsed.rest, '', scriptArg)
    assert.equal(parsed.value.normalize(), path.join(workspace, fileName).normalize())
  }
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
