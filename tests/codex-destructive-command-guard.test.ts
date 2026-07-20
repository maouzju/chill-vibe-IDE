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
