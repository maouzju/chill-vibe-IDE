import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { readWorkspaceFile, writeWorkspaceFile } from '../server/file-system.ts'
import { resolveOpenableFilePath } from '../src/components/structured-file-paths.ts'
import { resolveExistingWorkspaceFilePath } from '../src/components/workspace-file-fallback.ts'

// 症状 (2026-08-14): agent 改了工作区外的文件，改动卡里点开是空的。
// 根因: 渲染侧 resolveOpenableFilePath 放行工作区外绝对路径并把把关责任交给服务端，
//   服务端白名单却只有 workspace/~/.claude/~/.codex —— 两侧的假设从来没对上过。
// 这条测试走完整条链（解析 → 兜底查找 → 真实读盘），任何一侧再单独改假设都会在这里变红。

const createFixture = async (t: { after: (fn: () => Promise<void>) => void }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-outside-open-'))
  const workspace = path.join(root, 'workspace')
  const outsideProject = path.join(root, 'other-project', 'src')
  await mkdir(workspace, { recursive: true })
  await mkdir(outsideProject, { recursive: true })

  const outsideFile = path.join(outsideProject, 'main.rs')
  await writeFile(outsideFile, 'fn main() {}\n', 'utf8')

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  return { workspace, outsideFile }
}

const neverLooksUp = {
  listDirectory: async () => {
    throw new Error('an absolute path must not trigger a workspace lookup')
  },
  searchFiles: async () => {
    throw new Error('an absolute path must not trigger a workspace search')
  },
}

test('clicking an agent-edited file outside the workspace reaches its real content', async (t) => {
  const { workspace, outsideFile } = await createFixture(t)

  // 1. 渲染侧：改动卡把 provider 给的绝对路径解析成可点目标。
  const openPath = resolveOpenableFilePath(workspace, outsideFile)
  assert.notEqual(openPath, null, 'an out-of-workspace absolute path must stay openable')

  // 2. 点击时的存在性兜底对绝对路径原样放行，不去工作区里猜同名文件。
  const resolved = await resolveExistingWorkspaceFilePath(openPath as string, neverLooksUp)

  // 3. 桌面 IPC 通道（electron/backend.ts 的 DESKTOP_FILE_ACCESS）真的读得到内容。
  const result = await readWorkspaceFile(
    { workspacePath: workspace, relativePath: resolved },
    { allowOutsideWorkspace: true },
  )

  assert.equal(result.content, 'fn main() {}\n')
})

test('the same file stays editable, so it does not open into a dead end', async (t) => {
  const { workspace, outsideFile } = await createFixture(t)
  const openPath = resolveOpenableFilePath(workspace, outsideFile) as string

  await writeWorkspaceFile(
    {
      workspacePath: workspace,
      relativePath: openPath,
      content: 'fn main() { println!("edited"); }\n',
      encoding: 'utf8',
    },
    { allowOutsideWorkspace: true },
  )

  const reread = await readWorkspaceFile(
    { workspacePath: workspace, relativePath: openPath },
    { allowOutsideWorkspace: true },
  )
  assert.equal(reread.content, 'fn main() { println!("edited"); }\n')
})

test('the browser/HTTP path keeps rejecting the very same click', async (t) => {
  const { workspace, outsideFile } = await createFixture(t)
  const openPath = resolveOpenableFilePath(workspace, outsideFile) as string

  // No opt-in = the HTTP route's behavior. Widening the desktop channel must not
  // widen this one, because `HOST=0.0.0.0` makes it reachable from the LAN.
  await assert.rejects(
    readWorkspaceFile({ workspacePath: workspace, relativePath: openPath }),
    /Path traversal is not allowed/,
  )
})
