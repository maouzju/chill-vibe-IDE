import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectPastedFilePaths,
  formatPastedFilePathInsertion,
  insertTextAtSelection,
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
