import assert from 'node:assert/strict'
import { mkdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assessCodexToolUse,
  type CodexSafetyAssessment,
} from '../server/codex-destructive-command-guard.js'

const workspace = path.resolve(os.tmpdir(), 'chill-vibe-safety-workspace')
const home = path.resolve(os.tmpdir(), 'chill-vibe-real-home')
const codexHome = path.join(home, '.codex')
const appData = path.resolve(os.tmpdir(), 'chill-vibe-data')

const assess = (command: string): CodexSafetyAssessment =>
  assessCodexToolUse({
    cwd: workspace,
    tool_name: 'Bash',
    tool_input: { command },
  }, {
    platform: 'win32',
    workspaceRoot: workspace,
    protectedHome: home,
    codexHome,
    appDataDir: appData,
  })

const assessWorkspaceBoundary = (
  toolName: string,
  toolInput: Record<string, unknown>,
  workspaceRoot = workspace,
): CodexSafetyAssessment =>
  assessCodexToolUse({
    cwd: workspaceRoot,
    tool_name: toolName,
    tool_input: toolInput,
  }, {
    platform: process.platform,
    workspaceRoot,
    protectedHome: home,
    codexHome,
    appDataDir: appData,
    destructiveCommandProtectionEnabled: false,
    outsideWorkspaceWriteEnabled: false,
  })

test('blocks the PowerShell $home collision followed by recursive deletion', () => {
  const result = assess([
    `$home = Join-Path $env:TEMP 'isolated-codex-home'`,
    'if (Test-Path $home) { Remove-Item $home -Recurse -Force }',
  ].join('; '))

  assert.equal(result.allowed, false)
  assert.match(result.reason ?? '', /\$home|HOME/i)
})

test('blocks recursive deletion of the real home, workspace root, ancestors, and protected metadata', () => {
  const commands = [
    `Remove-Item -LiteralPath '${home}' -Recurse -Force`,
    `rm -rf '${workspace}'`,
    `rm -rf '${path.dirname(workspace)}'`,
    `Remove-Item '${path.join(workspace, '.git')}' -Recurse -Force`,
    `Remove-Item '${codexHome}' -Recurse -Force`,
    `Remove-Item '${appData}' -Recurse -Force`,
  ]

  for (const command of commands) {
    assert.equal(assess(command).allowed, false, command)
  }
})

test('blocks unresolved variables, recursive wildcards, and broad destructive Git commands', () => {
  const commands = [
    'rm -rf "$UNRESOLVED_TARGET"',
    'rm -rf "${UNRESOLVED_TARGET}"',
    'rm -rf "$(pwd)"',
    'Remove-Item $unknown -Recurse -Force',
    'Remove-Item @($env:USERPROFILE) -Recurse -Force',
    'rm -rf *',
    'git clean -fdx',
    'git reset --hard HEAD',
    'git restore .',
    "python -c \"import shutil; shutil.rmtree(target)\"",
    "python -c \"import tempfile; tempfile.TemporaryDirectory(); mount_bind(workspace, mounted_repo)\"",
  ]

  for (const command of commands) {
    assert.equal(assess(command).allowed, false, command)
  }
})

test('blocks real-home descendants outside the workspace but allows workspace children under home', () => {
  const nestedWorkspace = path.join(home, 'projects', 'repo')
  const assessNestedWorkspace = (command: string): CodexSafetyAssessment =>
    assessCodexToolUse({
      cwd: nestedWorkspace,
      tool_name: 'Bash',
      tool_input: { command },
    }, {
      platform: 'win32',
      workspaceRoot: nestedWorkspace,
      protectedHome: home,
      codexHome,
      appDataDir: appData,
    })

  assert.equal(
    assessNestedWorkspace(`Remove-Item '${path.join(home, 'Documents')}' -Recurse -Force`).allowed,
    false,
  )
  assert.deepEqual(
    assessNestedWorkspace(`Remove-Item '${path.join(nestedWorkspace, 'dist')}' -Recurse -Force`),
    { allowed: true },
  )
})

test('allows explicit recursive cleanup of ordinary workspace child directories', () => {
  for (const command of [
    `Remove-Item -LiteralPath '${path.join(workspace, 'dist')}' -Recurse -Force`,
    `rm -rf '${path.join(workspace, 'node_modules')}'`,
    `python -c "import shutil; shutil.rmtree('${path.join(workspace, 'tmp', 'generated')}')"`,
  ]) {
    assert.deepEqual(assess(command), { allowed: true }, command)
  }
})

test('blocks recursive deletion outside the workspace and relative targets with hidden tool workdirs', () => {
  for (const command of [
    `Remove-Item -LiteralPath '${path.resolve(os.tmpdir(), 'unrelated-data')}' -Recurse -Force`,
    "Remove-Item -LiteralPath '.\\dist' -Recurse -Force",
    'rm -rf ./node_modules',
  ]) {
    assert.equal(assess(command).allowed, false, command)
  }
})

test('uses the IDE-protected workspace instead of trusting a changed hook cwd', () => {
  const changedCwd = path.resolve(os.tmpdir(), 'attacker-controlled-cwd')
  const result = assessCodexToolUse({
    cwd: changedCwd,
    tool_name: 'Bash',
    tool_input: {
      command: `Remove-Item '${path.join(changedCwd, 'child')}' -Recurse -Force`,
    },
  }, {
    platform: 'win32',
    workspaceRoot: workspace,
    protectedHome: home,
    codexHome,
    appDataDir: appData,
  })

  assert.equal(result.allowed, false)
})

test('blocks recursive cleanup that would traverse a mounted descendant', () => {
  const cleanupRoot = path.join(workspace, 'tmp', 'cleanup-root')
  const result = assessCodexToolUse({
    cwd: workspace,
    tool_name: 'Bash',
    tool_input: {
      command: `Remove-Item '${cleanupRoot}' -Recurse -Force`,
    },
  }, {
    platform: 'win32',
    workspaceRoot: workspace,
    protectedHome: home,
    codexHome,
    appDataDir: appData,
    mountPoints: [path.join(cleanupRoot, 'mounted-repository')],
  })

  assert.equal(result.allowed, false)
})

test('allows non-destructive shell commands', () => {
  assert.deepEqual(assess('pnpm test:quality'), { allowed: true })
  assert.deepEqual(assess("rg --fixed-strings 'Remove-Item' server"), { allowed: true })
})

// 2026-11-20 审查：删除判定曾只认整串开头或 ; & | 之后的命令，换行、包一层 shell、
// sudo/xargs/find -exec 前缀、参数后置都能绕过。这些命令只作为字符串传给判定函数。
test('blocks deletions hidden behind newlines, shell wrappers, prefixes, and trailing flags', () => {
  const commands = [
    `cd '${workspace}'\nrm -rf '${home}'`,
    `Set-Location '${workspace}'\r\nRemove-Item '${home}' -Recurse -Force`,
    `Set-Location '${workspace}'\nif ($true) {\n  Remove-Item -LiteralPath '${home}' -Recurse -Force\n}`,
    'bash -lc "rm -rf ~"',
    "sh -c 'cd /tmp && rm -rf ~'",
    `sudo rm -rf '${home}'`,
    `sudo -u root rm -rf '${home}'`,
    `env FOO=1 rm -rf '${home}'`,
    `FOO=1 rm -rf '${home}'`,
    `/usr/bin/rm -rf '${home}'`,
    `find '${home}' -exec rm -rf {} +`,
    `find '${home}' -type f -delete`,
    `rm '${home}' -rf`,
    `rm --recursive '${home}'`,
    'ls | xargs rm -rf',
    `rm \\\n  -rf '${home}'`,
    'echo $(rm -rf ~)',
    `cmd /c "rmdir /s /q ${home}"`,
    `powershell -NoProfile -Command "Remove-Item '${home}' -Recurse -Force"`,
    `powershell -NoProfile -EncodedCommand ${Buffer.from(`Remove-Item '${home}' -Recurse -Force`, 'utf16le').toString('base64')}`,
    'git status\ngit reset --hard HEAD',
    'sudo git clean -fdx',
    'echo `rm -rf ~`',
    `cd ${workspace}\\\nrm -rf '${home}'`,
    `powershell -ExecutionPolicy Bypass -Command "Remove-Item '${home}' -Recurse"`,
    `if true; then rm -rf '${home}'; fi`,
  ]

  for (const command of commands) {
    assert.equal(assess(command).allowed, false, command)
  }
})

test('checks every comma-separated Remove-Item path instead of only the first', () => {
  const inside = path.join(workspace, 'tmp')
  const outside = path.resolve(os.tmpdir(), 'chill-vibe-unrelated-projects')
  const commands = [
    `Remove-Item -LiteralPath ${inside},${outside} -Recurse -Force`,
    `Remove-Item ${inside},${outside} -Recurse -Force`,
    `Remove-Item -Path '${inside}','${outside}' -Recurse -Force`,
    `Remove-Item -Path '${inside}', '${outside}' -Recurse -Force`,
    `Remove-Item -Recurse -Force -LiteralPath '${inside}', '${outside}'`,
  ]

  for (const command of commands) {
    assert.equal(assess(command).allowed, false, command)
  }

  assert.deepEqual(
    assess(`Remove-Item -LiteralPath '${inside}','${path.join(workspace, 'dist')}' -Recurse -Force`),
    { allowed: true },
  )
})

test('still allows ordinary multi-line and prefixed commands after segment splitting', () => {
  for (const command of [
    'git status\ngit diff --stat',
    'pnpm install\r\npnpm test:quality',
    'git log --oneline | head -n 5',
    'echo hello && echo world',
    'bash -lc "pnpm install && pnpm test:quality"',
    `sudo ls '${workspace}'`,
    `find '${workspace}' -name '*.log'`,
    `cd '${workspace}'\nrm -rf '${path.join(workspace, 'dist')}'`,
    `rm -rf '${path.join(workspace, 'a')}'\nrm -rf '${path.join(workspace, 'b')}'`,
    `find '${path.join(workspace, 'dist')}' -name '*.map' -delete`,
    `Set-Location '${workspace}'\nif (Test-Path '${path.join(workspace, 'dist')}') { Remove-Item '${path.join(workspace, 'dist')}' -Recurse -Force }`,
    "rg --fixed-strings 'Remove-Item' server",
    'git rm -r --cached foo',
    'pnpm test 2>&1 | tail -n 20',
  ]) {
    assert.deepEqual(assess(command), { allowed: true }, command)
  }
})

// 2026-11-20 审查（中危）：PowerShell 静态调用 `[IO.Directory]::Delete(x, $true)` 和
// DirectoryInfo 的 `.Delete($true)` 曾被判为非破坏性直接放行。
test('blocks PowerShell .NET recursive directory deletes while allowing look-alikes', () => {
  const outside = path.join(home, 'Documents')
  const inside = path.join(workspace, 'dist')
  for (const command of [
    `[IO.Directory]::Delete('${outside}', $true)`,
    `[System.IO.Directory]::Delete('${outside}', $true)`,
    `powershell -NoProfile -Command "[IO.Directory]::Delete('${outside}', $true)"`,
    `[IO.Directory]::Delete($target, $true)`,
    `(Get-Item '${outside}').Delete($true)`,
    `dotnet script -e "new DirectoryInfo(@\\"${outside}\\").Delete(true);"`,
  ]) {
    assert.equal(assess(command).allowed, false, command)
  }

  for (const command of [
    `[IO.Directory]::Delete('${outside}')`,
    `[IO.Directory]::Delete('${outside}', $false)`,
    `[IO.Directory]::Delete('${inside}', $true)`,
    `[IO.File]::Delete('${path.join(workspace, 'a.txt')}')`,
    `(Get-Item '${path.join(workspace, 'a.txt')}').Delete()`,
    'node -e "const s = new Set([true]); s.delete(true)"',
  ]) {
    assert.deepEqual(assess(command), { allowed: true }, command)
  }
})

// 2026-11-20 审查（中危）：关掉项目外写入后，`2>/dev/null`、`2>$null`、`2>&1` 这类
// 只丢弃 / 合并输出的重定向被当成项目外写入拦截，只读命令全军覆没。
test('lets discard-only redirections through the workspace write boundary', () => {
  const outside = path.join(path.dirname(workspace), 'result.txt')
  for (const command of [
    'git rev-parse HEAD 2>/dev/null',
    'ls >/dev/null 2>&1',
    'git status &>/dev/null',
    'Get-Command node 2>$null',
    'Get-Command node > $NULL',
    'Get-Command node *>$null',
    'where node >NUL 2>NUL',
    'npm test 2>&1',
    'npm test 2>&1 | tail -n 20',
    'bash -lc "git rev-parse HEAD 2>/dev/null"',
  ]) {
    assert.deepEqual(assessWorkspaceBoundary('Bash', { command }), { allowed: true }, command)
  }

  for (const command of [
    `npm test 2>&1 > '${outside}'`,
    `git rev-parse HEAD 2>/dev/null > '${outside}'`,
    'echo no > /dev/nullx',
    'echo no 2>$nullTarget',
    `Get-Command node 2>$null; echo no > '${outside}'`,
  ]) {
    assert.equal(assessWorkspaceBoundary('Bash', { command }).allowed, false, command)
  }
})

// 2026-11-20 审查（中危）：apply_patch 的 `*** Move to:` 目标没进边界检查，
// Update File 指向工作区内即可把文件挪到项目外。
test('checks apply_patch Move to targets against the workspace boundary', () => {
  const patch = (moveTo: string) => [
    '*** Begin Patch',
    `*** Update File: ${path.join(workspace, 'src', 'a.txt')}`,
    `*** Move to: ${moveTo}`,
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n')

  assert.equal(
    assessWorkspaceBoundary('apply_patch', { patch: patch(path.join(path.dirname(workspace), 'escaped.txt')) }).allowed,
    false,
  )
  assert.equal(
    assessWorkspaceBoundary('apply_patch', { input: patch(path.join('..', 'escaped.txt')) }).allowed,
    false,
  )
  assert.deepEqual(
    assessWorkspaceBoundary('apply_patch', { patch: patch(path.join(workspace, 'src', 'b.txt')) }),
    { allowed: true },
  )
})

test('applies the workspace write boundary to every line and prefixed command', () => {
  const inside = path.join(workspace, 'generated', 'result.txt')
  const outside = path.join(path.dirname(workspace), 'result.txt')

  for (const command of [
    `Set-Location '${workspace}'\nSet-Content -LiteralPath '${outside}' -Value no`,
    `cd '${workspace}'\ncp '${inside}' '${outside}'`,
    `sudo cp '${inside}' '${outside}'`,
    `Set-Content -Path '${inside}','${outside}' -Value no`,
  ]) {
    assert.equal(assessWorkspaceBoundary('Bash', { command }).allowed, false, command)
  }

  assert.deepEqual(
    assessWorkspaceBoundary('Bash', {
      command: `Set-Location '${workspace}'\nSet-Content -LiteralPath '${inside}' -Value ok`,
    }),
    { allowed: true },
  )
})

test('allows direct file writes inside the workspace and blocks outside or parent traversal targets', () => {
  assert.deepEqual(
    assessWorkspaceBoundary('Write', { file_path: path.join(workspace, 'src', 'inside.ts') }),
    { allowed: true },
  )

  for (const filePath of [
    path.join(path.dirname(workspace), 'outside.ts'),
    path.join('..', 'outside.ts'),
  ]) {
    const result = assessWorkspaceBoundary('Edit', { file_path: filePath })
    assert.equal(result.allowed, false, filePath)
    assert.match(result.reason ?? '', /工作区|项目/i)
  }
})

test('blocks common shell writes outside the workspace while allowing the same forms inside', () => {
  const inside = path.join(workspace, 'generated', 'result.txt')
  const outside = path.join(path.dirname(workspace), 'result.txt')

  assert.deepEqual(
    assessWorkspaceBoundary('Bash', { command: `Set-Content -LiteralPath '${inside}' -Value ok` }),
    { allowed: true },
  )

  for (const command of [
    `Set-Content -LiteralPath '${outside}' -Value no`,
    `Copy-Item '${inside}' -Destination '${outside}'`,
    `echo no > '${outside}'`,
  ]) {
    assert.equal(assessWorkspaceBoundary('Bash', { command }).allowed, false, command)
  }
})

test('resolves existing symlink or junction ancestors before allowing a direct write', async () => {
  const tempRoot = path.join(
    os.tmpdir(),
    `chill-vibe-workspace-write-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const workspaceRoot = path.join(tempRoot, 'workspace')
  const outsideRoot = path.join(tempRoot, 'outside')
  const linkedRoot = path.join(workspaceRoot, 'linked-outside')

  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(outsideRoot, { recursive: true })

  try {
    await symlink(outsideRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const result = assessWorkspaceBoundary(
      'Write',
      { file_path: path.join(linkedRoot, 'escaped.txt') },
      workspaceRoot,
    )

    assert.equal(result.allowed, false)
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
})

test('keeps destructive-command protection independent from the workspace write boundary', () => {
  const outside = path.join(path.dirname(workspace), 'outside-cleanup')
  const command = `Remove-Item -LiteralPath '${outside}' -Recurse -Force`

  assert.deepEqual(
    assessCodexToolUse({
      cwd: workspace,
      tool_name: 'Bash',
      tool_input: { command },
    }, {
      platform: process.platform,
      workspaceRoot: workspace,
      protectedHome: home,
      codexHome,
      appDataDir: appData,
      destructiveCommandProtectionEnabled: false,
      outsideWorkspaceWriteEnabled: true,
    }),
    { allowed: true },
  )

  assert.equal(assessWorkspaceBoundary('Bash', { command }).allowed, false)
})
