import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectPastedFilePaths,
  formatPastedFilePathInsertion,
  getPastedClipboardText,
  insertTextAtSelection,
  partitionDroppedFiles,
} from '../src/components/composer-paste'

const fakeFile = (name: string) => new File(['x'], name)

test('collectPastedFilePaths resolves each file through the provided resolver', () => {
  const a = fakeFile('a.txt')
  const b = fakeFile('b.pdf')
  const paths = new Map<File, string>([
    [a, 'D:\\docs\\a.txt'],
    [b, 'D:\\docs\\b.pdf'],
  ])

  assert.deepEqual(
    collectPastedFilePaths([a, b], (file) => paths.get(file) ?? ''),
    ['D:\\docs\\a.txt', 'D:\\docs\\b.pdf'],
  )
})

test('collectPastedFilePaths drops files whose resolver returns empty or throws', () => {
  const ok = fakeFile('ok.txt')
  const empty = fakeFile('clipboard-bitmap.png')
  const boom = fakeFile('boom.txt')

  const resolved = collectPastedFilePaths([empty, ok, boom], (file) => {
    if (file === boom) throw new Error('no path for this file')
    return file === ok ? 'C:\\ok.txt' : ''
  })

  assert.deepEqual(resolved, ['C:\\ok.txt'])
})

test('formatPastedFilePathInsertion quotes paths containing whitespace and joins with single spaces', () => {
  assert.equal(formatPastedFilePathInsertion(['D:\\a.txt']), 'D:\\a.txt')
  assert.equal(
    formatPastedFilePathInsertion(['C:\\My Files\\report v2.pdf']),
    '"C:\\My Files\\report v2.pdf"',
  )
  assert.equal(
    formatPastedFilePathInsertion(['D:\\a.txt', 'C:\\My Files\\b.txt']),
    'D:\\a.txt "C:\\My Files\\b.txt"',
  )
})

test('insertTextAtSelection inserts into an empty draft and places the caret at the end', () => {
  const result = insertTextAtSelection('', 0, 0, 'D:\\a.txt')
  assert.equal(result.value, 'D:\\a.txt')
  assert.equal(result.caret, 'D:\\a.txt'.length)
})

test('insertTextAtSelection pads with spaces only against adjacent non-whitespace characters', () => {
  const result = insertTextAtSelection('看看这个文件', 6, 6, 'D:\\a.txt')
  assert.equal(result.value, '看看这个文件 D:\\a.txt')
  assert.equal(result.caret, result.value.length)

  const middle = insertTextAtSelection('前面 后面', 3, 3, 'D:\\a.txt')
  assert.equal(middle.value, '前面 D:\\a.txt 后面')
  assert.equal(middle.caret, '前面 D:\\a.txt '.length)

  const afterSpace = insertTextAtSelection('前面 ', 3, 3, 'D:\\a.txt')
  assert.equal(afterSpace.value, '前面 D:\\a.txt')
  assert.equal(afterSpace.caret, afterSpace.value.length)
})

test('insertTextAtSelection replaces the selected range', () => {
  const result = insertTextAtSelection('把 XXX 发给我', 2, 5, 'D:\\a.txt')
  assert.equal(result.value, '把 D:\\a.txt 发给我')
  assert.equal(result.caret, '把 D:\\a.txt'.length)
})

test('partitionDroppedFiles splits dropped files into image attachments and path candidates by MIME type', () => {
  const png = new File(['x'], 'shot.png', { type: 'image/png' })
  const gif = new File(['x'], 'anim.gif', { type: 'image/gif' })
  const svg = new File(['x'], 'logo.svg', { type: 'image/svg+xml' })
  const txt = new File(['x'], 'notes.txt', { type: 'text/plain' })
  const untyped = new File(['x'], 'archive.bin', { type: '' })

  const result = partitionDroppedFiles([png, txt, gif, svg, untyped])

  assert.deepEqual(result.imageFiles, [png, gif])
  assert.deepEqual(result.pathCandidateFiles, [txt, svg, untyped])
})

test('partitionDroppedFiles returns empty groups for an empty drop', () => {
  assert.deepEqual(partitionDroppedFiles([]), { imageFiles: [], pathCandidateFiles: [] })
})

test('getPastedClipboardText prefers the clipboard plain-text table payload', () => {
  const plainText = '姓名\t部门\n小明\t研发'
  const html = '<table><tr><td>错误的 HTML 文本</td></tr></table>'

  assert.equal(getPastedClipboardText(plainText, html), plainText)
})

test('getPastedClipboardText converts an HTML table to tab-separated rows when plain text is missing', () => {
  const html = `
    <table>
      <tr><th>姓名</th><th>备注</th></tr>
      <tr><td>小明 &amp; 小红</td><td>第一行<br>第二行</td></tr>
    </table>
  `

  assert.equal(
    getPastedClipboardText('', html),
    '姓名\t备注\n小明 & 小红\t第一行\n第二行',
  )
})

test('getPastedClipboardText strips executable HTML and keeps text when the clipboard HTML is malformed', () => {
  const html = '<script>alert(1)</script><p>安全内容</p><img src="https://example.com/a.png">'

  assert.equal(getPastedClipboardText('  ', html), '安全内容')
})
