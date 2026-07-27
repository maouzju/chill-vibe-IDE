import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  stickyNoteDocumentSchema,
  stickyNoteSaveRequestSchema,
  stickyNoteSearchRequestSchema,
  stickyNoteVersionRequestSchema,
} from '../shared/schema.ts'
import {
  getStickyNoteWorkspaceDirectory,
  listStickyNotes,
  loadStickyNote,
  restoreStickyNoteVersion,
  saveStickyNote,
  searchStickyNotes,
  writeStickyNoteFileAtomically,
} from '../server/sticky-note-store.ts'

describe('sticky note local store', () => {
  let dataDir = ''
  let clock = Date.parse('2026-07-27T08:00:00.000Z')
  let sequence = 0

  const options = () => ({
    dataDir,
    now: () => new Date(clock),
    createId: () => `version-${++sequence}`,
  })

  beforeEach(async () => {
    dataDir = path.join(
      os.tmpdir(),
      `chill-vibe-sticky-note-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    await mkdir(dataDir, { recursive: true })
    clock = Date.parse('2026-07-27T08:00:00.000Z')
    sequence = 0
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('validates save, version, and document payloads at the process boundary', () => {
    const request = stickyNoteSaveRequestSchema.parse({
      workspacePath: 'D:/repo/schema',
      noteId: 'note-schema',
      title: 'Schema note',
      content: 'safe payload',
      checkpoint: true,
    })
    assert.equal(request.noteId, 'note-schema')
    assert.equal(
      stickyNoteVersionRequestSchema.parse({ ...request, versionId: 'version-1' }).versionId,
      'version-1',
    )
    assert.equal(
      stickyNoteDocumentSchema.parse({
        noteId: 'note-schema',
        title: 'Schema note',
        fileName: 'Schema note--note-schema.md',
        createdAt: '2026-07-27T08:00:00.000Z',
        updatedAt: '2026-07-27T08:00:00.000Z',
        preview: 'safe payload',
        content: 'safe payload',
        versions: [],
      }).content,
      'safe payload',
    )
    assert.equal(
      stickyNoteSearchRequestSchema.parse({ workspacePath: 'D:/repo/schema', query: 'release' }).query,
      'release',
    )
  })

  it('falls back to a direct overwrite when Windows blocks replacement rename', async () => {
    const target = path.join(dataDir, 'windows-locked-note.md')
    await mkdir(path.dirname(target), { recursive: true })
    await import('node:fs/promises').then(({ writeFile }) => writeFile(target, 'old', 'utf8'))

    await writeStickyNoteFileAtomically(target, 'new', {
      renameFile: async () => {
        const error = new Error('operation not permitted') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      },
    })

    assert.equal(await readFile(target, 'utf8'), 'new')
    assert.deepEqual(
      (await readdir(dataDir)).filter((name) => name.endsWith('.tmp')),
      [],
    )
  })

  it('keeps multiple notes and workspaces independent', async () => {
    await saveStickyNote(
      {
        workspacePath: 'D:/repo/one',
        noteId: 'note-a',
        title: '发布清单',
        content: '先跑测试',
        checkpoint: true,
      },
      options(),
    )
    clock += 1_000
    await saveStickyNote(
      {
        workspacePath: 'D:/repo/one',
        noteId: 'note-b',
        title: '灵感',
        content: '第二份内容',
        checkpoint: true,
      },
      options(),
    )
    await saveStickyNote(
      {
        workspacePath: 'D:/repo/two',
        noteId: 'note-a',
        title: '另一个工作区',
        content: '不能串过来',
        checkpoint: true,
      },
      options(),
    )

    const workspaceOne = await listStickyNotes({ workspacePath: 'D:/repo/one' }, options())
    const workspaceTwo = await listStickyNotes({ workspacePath: 'D:/repo/two' }, options())

    assert.deepEqual(workspaceOne.notes.map((note) => note.noteId), ['note-b', 'note-a'])
    assert.deepEqual(workspaceOne.notes.map((note) => note.title), ['灵感', '发布清单'])
    assert.deepEqual(workspaceTwo.notes.map((note) => note.noteId), ['note-a'])
    assert.equal(
      (await loadStickyNote({ workspacePath: 'D:/repo/one', noteId: 'note-a' }, options())).content,
      '先跑测试',
    )
    assert.equal(
      (await loadStickyNote({ workspacePath: 'D:/repo/two', noteId: 'note-a' }, options())).content,
      '不能串过来',
    )
  })

  it('searches the current workspace by title or full content with CJK and case-insensitive matching', async () => {
    await saveStickyNote({
      workspacePath: 'D:/repo/search',
      noteId: 'release-note',
      title: 'Release Checklist',
      content: 'Run quality checks before shipping.',
      checkpoint: true,
    }, options())
    clock += 1_000
    await saveStickyNote({
      workspacePath: 'D:/repo/search',
      noteId: 'cjk-note',
      title: '灵感记录',
      content: '需要补充便签全文搜索能力。',
      checkpoint: true,
    }, options())
    await saveStickyNote({
      workspacePath: 'D:/repo/other',
      noteId: 'other-note',
      title: 'Release Checklist Other',
      content: 'must stay isolated',
      checkpoint: true,
    }, options())

    assert.deepEqual(
      (await searchStickyNotes({ workspacePath: 'D:/repo/search', query: 'release' }, options())).notes.map((note) => note.noteId),
      ['release-note'],
    )
    assert.deepEqual(
      (await searchStickyNotes({ workspacePath: 'D:/repo/search', query: 'QUALITY CHECKS' }, options())).notes.map((note) => note.noteId),
      ['release-note'],
    )
    assert.deepEqual(
      (await searchStickyNotes({ workspacePath: 'D:/repo/search', query: '全文搜索' }, options())).notes.map((note) => note.noteId),
      ['cjk-note'],
    )
    assert.deepEqual(
      (await searchStickyNotes({ workspacePath: 'D:/repo/search', query: '   ' }, options())).notes.map((note) => note.noteId),
      ['cjk-note', 'release-note'],
    )
  })

  it('renames the readable markdown file without changing note identity', async () => {
    const first = await saveStickyNote(
      {
        workspacePath: 'D:/repo/rename',
        noteId: 'note-rename',
        title: '旧名字',
        content: '内容不变',
        checkpoint: true,
      },
      options(),
    )
    clock += 1_000
    const renamed = await saveStickyNote(
      {
        workspacePath: 'D:/repo/rename',
        noteId: 'note-rename',
        title: '新名字',
        content: '内容不变',
        checkpoint: false,
      },
      options(),
    )

    assert.equal(renamed.noteId, 'note-rename')
    assert.notEqual(renamed.fileName, first.fileName)
    assert.match(renamed.fileName, /^新名字--note-rename\.md$/)

    const directory = getStickyNoteWorkspaceDirectory('D:/repo/rename', dataDir)
    const files = await readdir(directory)
    assert.ok(files.includes(renamed.fileName))
    assert.ok(!files.includes(first.fileName))
    assert.equal(await readFile(path.join(directory, renamed.fileName), 'utf8'), '内容不变')
  })

  it('deduplicates checkpoints and retains only the newest 50 versions', async () => {
    for (let index = 0; index < 55; index += 1) {
      await saveStickyNote(
        {
          workspacePath: 'D:/repo/history-cap',
          noteId: 'note-history',
          title: '历史便签',
          content: `版本 ${index}`,
          checkpoint: true,
        },
        options(),
      )
      clock += 1_000
    }

    const beforeDuplicate = await loadStickyNote(
      { workspacePath: 'D:/repo/history-cap', noteId: 'note-history' },
      options(),
    )
    await saveStickyNote(
      {
        workspacePath: 'D:/repo/history-cap',
        noteId: 'note-history',
        title: '历史便签',
        content: '版本 54',
        checkpoint: true,
      },
      options(),
    )
    const afterDuplicate = await loadStickyNote(
      { workspacePath: 'D:/repo/history-cap', noteId: 'note-history' },
      options(),
    )

    assert.equal(beforeDuplicate.versions.length, 50)
    assert.equal(afterDuplicate.versions.length, 50)
    assert.equal(afterDuplicate.versions[0]?.preview, '版本 54')
    assert.equal(afterDuplicate.versions.at(-1)?.preview, '版本 5')
  })

  it('snapshots the current content before restoring an older version', async () => {
    const first = await saveStickyNote(
      {
        workspacePath: 'D:/repo/restore',
        noteId: 'note-restore',
        title: '可恢复',
        content: '第一版',
        checkpoint: true,
      },
      options(),
    )
    clock += 1_000
    await saveStickyNote(
      {
        workspacePath: 'D:/repo/restore',
        noteId: 'note-restore',
        title: '可恢复',
        content: '第二版',
        checkpoint: false,
      },
      options(),
    )

    const restored = await restoreStickyNoteVersion(
      {
        workspacePath: 'D:/repo/restore',
        noteId: 'note-restore',
        versionId: first.versions[0]!.id,
      },
      options(),
    )

    assert.equal(restored.content, '第一版')
    assert.equal(restored.versions[0]?.preview, '第二版')
    assert.ok(restored.versions.some((version) => version.preview === '第一版'))
  })

  it('treats a markdown file deleted in the system as a deleted note', async () => {
    const note = await saveStickyNote(
      {
        workspacePath: 'D:/repo/manual-delete',
        noteId: 'note-delete',
        title: '用户自己删',
        content: '本地文件',
        checkpoint: true,
      },
      options(),
    )
    const directory = getStickyNoteWorkspaceDirectory('D:/repo/manual-delete', dataDir)
    await unlink(path.join(directory, note.fileName))

    const listed = await listStickyNotes({ workspacePath: 'D:/repo/manual-delete' }, options())
    assert.deepEqual(listed.notes, [])
    await assert.rejects(
      loadStickyNote({ workspacePath: 'D:/repo/manual-delete', noteId: 'note-delete' }, options()),
      /not found/i,
    )
  })
})
