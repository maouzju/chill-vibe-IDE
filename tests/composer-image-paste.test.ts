import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { collectPastedImageFiles } from '../src/components/composer-image-paste.ts'

const item = (
  overrides: Partial<{ kind: string; type: string; file: File | null }> = {},
): DataTransferItem => {
  const { kind = 'file', type = 'image/png', file = { name: `${type}.bin` } as unknown as File } =
    overrides

  return { kind, type, getAsFile: () => file } as unknown as DataTransferItem
}

const list = (items: DataTransferItem[]): DataTransferItemList =>
  ({ ...items, length: items.length } as unknown as DataTransferItemList)

describe('collectPastedImageFiles', () => {
  it('keeps only supported image files', () => {
    const files = collectPastedImageFiles(
      list([
        item({ type: 'image/png' }),
        item({ type: 'image/jpeg' }),
        // 文本条目：粘贴普通文字时剪贴板里总有一条，绝不能被当成图片。
        item({ kind: 'string', type: 'text/plain' }),
        // 受支持列表之外的文件（例如 pdf / bmp）交给别的分支处理。
        item({ type: 'application/pdf' }),
      ]),
    )

    assert.deepEqual(
      files.map((file) => file.name),
      ['image/png.bin', 'image/jpeg.bin'],
    )
  })

  // getAsFile() 允许返回 null（条目已失效），照单收下会让下游拿到 undefined.file。
  it('drops entries whose file cannot be read', () => {
    assert.deepEqual(collectPastedImageFiles(list([item({ file: null })])), [])
  })

  it('tolerates a missing clipboard item list', () => {
    assert.deepEqual(collectPastedImageFiles(null), [])
  })
})
