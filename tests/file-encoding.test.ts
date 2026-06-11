import { mkdtemp, readFile as readRawFile, rm, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import iconv from 'iconv-lite'
import { readWorkspaceFile, writeWorkspaceFile } from '../server/file-system.js'

const makeWorkspace = async (t: Parameters<NonNullable<Parameters<typeof test>[0]>>[0]) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-file-encoding-'))
  t.after(async () => {
    await rm(workspace, { recursive: true, force: true })
  })
  return workspace
}

test('readWorkspaceFile decodes GBK content instead of mojibake', async (t) => {
  const workspace = await makeWorkspace(t)
  const original = '正在监听端口，请勿关闭本窗口或按任意键。\r\nPORT=8080\r\n'
  await writeFile(path.join(workspace, 'bat_test.log'), iconv.encode(original, 'gb18030'))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'bat_test.log' })

  assert.equal(result.binary, undefined)
  assert.equal(result.content, original)
  assert.equal(result.encoding, 'gb18030')
})

test('readWorkspaceFile keeps plain UTF-8 on the default path', async (t) => {
  const workspace = await makeWorkspace(t)
  const original = 'const ok = "中文 UTF-8 内容"\n'
  await writeFile(path.join(workspace, 'plain.ts'), original, 'utf8')

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'plain.ts' })

  assert.equal(result.content, original)
  assert.equal(result.encoding, 'utf8')
})

test('readWorkspaceFile treats a UTF-16 LE BOM file as text, not binary', async (t) => {
  const workspace = await makeWorkspace(t)
  const original = 'PowerShell 输出 hello\r\n'
  // PowerShell 5.1 Out-File default: UTF-16 LE with BOM. The NUL high bytes
  // must not trip the binary sniffer once the BOM identifies the file as text.
  await writeFile(path.join(workspace, 'ps-output.log'), Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(original, 'utf16le'),
  ]))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'ps-output.log' })

  assert.equal(result.binary, undefined)
  assert.equal(result.content, original)
  assert.equal(result.encoding, 'utf16le')
})

test('readWorkspaceFile strips the UTF-8 BOM from content and reports utf8bom', async (t) => {
  const workspace = await makeWorkspace(t)
  const original = '# update script\nWrite-Host "好"\n'
  await writeFile(path.join(workspace, 'update.ps1'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(original, 'utf8'),
  ]))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'update.ps1' })

  assert.equal(result.content, original)
  assert.equal(result.encoding, 'utf8bom')
})

test('GBK round-trip save preserves the original bytes and does not false-conflict', async (t) => {
  const workspace = await makeWorkspace(t)
  const original = '<title>页面治理标题</title>\r\n<p>关键词：404,4399</p>\r\n'
  const originalBytes = iconv.encode(original, 'gb18030')
  await writeFile(path.join(workspace, 'probe.html'), originalBytes)

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'probe.html' })
  assert.equal(read.content, original)

  // Saving the unchanged buffer with the revision from the read must not
  // report a conflict (the conflict probe has to decode with the same encoding).
  const write = await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'probe.html',
    content: read.content,
    expectedRevision: read.revision,
    encoding: read.encoding,
  })
  assert.equal(write.revision, read.revision)

  const after = await readRawFile(path.join(workspace, 'probe.html'))
  assert.deepEqual(after, originalBytes)
})

test('edited GBK content is written back in GBK, not UTF-8', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeFile(path.join(workspace, 'note.txt'), iconv.encode('旧内容\n', 'gb18030'))

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'note.txt' })
  const edited = '新内容：监听端口已关闭\n'

  await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'note.txt',
    content: edited,
    expectedRevision: read.revision,
    encoding: read.encoding,
  })

  const after = await readRawFile(path.join(workspace, 'note.txt'))
  assert.equal(iconv.decode(after, 'gb18030'), edited)
  // Mojibake regression guard: the bytes must NOT be valid UTF-8 for this text.
  assert.notEqual(after.toString('utf8'), edited)
})

test('UTF-8 BOM round-trip save keeps the BOM on disk', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeFile(path.join(workspace, 'with-bom.txt'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('line\n', 'utf8'),
  ]))

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'with-bom.txt' })
  await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'with-bom.txt',
    content: 'changed\n',
    expectedRevision: read.revision,
    encoding: read.encoding,
  })

  const after = await readRawFile(path.join(workspace, 'with-bom.txt'))
  assert.deepEqual(after.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]))
  assert.equal(after.subarray(3).toString('utf8'), 'changed\n')
})

test('writeWorkspaceFile without encoding keeps the legacy utf8 behavior', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeFile(path.join(workspace, 'legacy.txt'), 'old\n', 'utf8')

  const read = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'legacy.txt' })
  await writeWorkspaceFile({
    workspacePath: workspace,
    relativePath: 'legacy.txt',
    content: '新 utf8 内容\n',
    expectedRevision: read.revision,
  })

  const after = await readRawFile(path.join(workspace, 'legacy.txt'))
  assert.equal(after.toString('utf8'), '新 utf8 内容\n')
})

test('files with NUL bytes and no BOM are still detected as binary', async (t) => {
  const workspace = await makeWorkspace(t)
  await writeFile(path.join(workspace, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]))

  const result = await readWorkspaceFile({ workspacePath: workspace, relativePath: 'image.bin' })

  assert.equal(result.binary, true)
  assert.equal(result.content, '')
})
