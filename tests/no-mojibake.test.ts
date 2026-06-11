import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// UTF-8 中文/标点被按 GBK 错误转码后会出现的标志性罕见字（正常简体文案不会使用）。
// 例如 "文件" → "鏂囦欢"、"—" → "鈥?"、"在没有…" → "鍦ㄦ病鏈?"。
// 参见 AGENTS.md pitfall #95 / #107：Windows PowerShell 直接读写源码容易引入这类乱码。
const mojibakeMarkers = /[鈥銆锛馃囦鍦鏂嗐]/

const scanRoots = ['src', 'server', 'shared', 'electron']
const scanExtensions = new Set(['.ts', '.tsx', '.mts', '.mjs', '.css'])

const collectSourceFiles = (root: string): string[] => {
  const entries = fs.readdirSync(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }
    if (entry.isFile() && scanExtensions.has(path.extname(entry.name))) {
      files.push(fullPath)
    }
  }

  return files
}

test('source files contain no GBK mojibake sequences', () => {
  const repoRoot = process.cwd()
  const offending: string[] = []

  for (const root of scanRoots) {
    for (const filePath of collectSourceFiles(path.join(repoRoot, root))) {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
      lines.forEach((line, index) => {
        if (mojibakeMarkers.test(line)) {
          offending.push(`${path.relative(repoRoot, filePath)}:${index + 1} ${line.trim()}`)
        }
      })
    }
  }

  assert.deepEqual(
    offending,
    [],
    `发现疑似 GBK 乱码（UTF-8 文案被错误编码写入）：\n${offending.join('\n')}`,
  )
})
