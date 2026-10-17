import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  getLocalImageSnapshotKey,
  resolveSnapshotImagePath,
} from '../electron/local-image-snapshot.ts'
import { getLocalImageProtocolUrl } from '../shared/local-image-protocol.ts'
import { MessageImageSnapshotContext } from '../src/components/message-image-snapshot-context.ts'
import { renderMarkdown } from '../src/components/chat-card-rendering.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const withTempDirs = async (run: (dirs: { snapshots: string; source: string }) => Promise<void>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cv-img-snap-'))
  try {
    await run({ snapshots: path.join(root, 'snapshots'), source: path.join(root, 'shot.png') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('renderMarkdown tags message images with the owning message id', () => {
  const html = renderToStaticMarkup(
    <MessageImageSnapshotContext.Provider value="msg-1">
      <div>{renderMarkdown('![x](proj/shot.png)')}</div>
    </MessageImageSnapshotContext.Provider>,
  )
  const src = html.match(/<img[^>]*\bsrc="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&')

  assert.ok(src, `expected an <img> in: ${html}`)
  assert.equal(new URL(src).searchParams.get('snapshot'), 'msg-1')
})

test('renderMarkdown adds no snapshot param outside a message', () => {
  const html = renderToStaticMarkup(<div>{renderMarkdown('![x](proj/shot.png)')}</div>)
  const src = html.match(/<img[^>]*\bsrc="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&')

  assert.ok(src)
  assert.equal(new URL(src).searchParams.get('snapshot'), null)
})

test('getLocalImageSnapshotKey reads the snapshot param', () => {
  const url = `${getLocalImageProtocolUrl('a.png')}&snapshot=msg-9`
  assert.equal(getLocalImageSnapshotKey(url), 'msg-9')
  assert.equal(getLocalImageSnapshotKey(getLocalImageProtocolUrl('a.png')), null)
})

test('snapshot freezes the image as it was when first displayed', async () => {
  await withTempDirs(async ({ snapshots, source }) => {
    await writeFile(source, 'v1')
    const first = await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source })
    assert.ok(first)
    assert.equal(await readFile(first, 'utf8'), 'v1')

    await writeFile(source, 'v2')
    const again = await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source })
    assert.equal(await readFile(again!, 'utf8'), 'v1')

    const later = await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-2', target: source })
    assert.equal(await readFile(later!, 'utf8'), 'v2')
  })
})

test('snapshot survives deletion of the source file but a never-shown missing file is null', async () => {
  await withTempDirs(async ({ snapshots, source }) => {
    assert.equal(
      await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source }),
      null,
    )

    await writeFile(source, 'v1')
    await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source })
    await rm(source)

    const kept = await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source })
    assert.equal(await readFile(kept!, 'utf8'), 'v1')
  })
})

test('snapshot copy leaves no partial file behind in the snapshot directory', async () => {
  await withTempDirs(async ({ snapshots, source }) => {
    await writeFile(source, 'v1')
    await resolveSnapshotImagePath({ snapshotDir: snapshots, snapshotKey: 'msg-1', target: source })
    const names = await readdir(snapshots)
    assert.equal(names.length, 1)
    assert.ok(!names[0].endsWith('.partial'))
  })
})
