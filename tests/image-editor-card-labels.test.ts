import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 症状：图片编辑卡中文标签整片显示为 "??"（2026-09-17 截图实锤）。
// 根因：v0.16.17 提交时 zh-CN 文案表被单字节编码写坏，源码里已是字面量 '?'，不可逆。
// 为什么不能只靠快照：快照覆盖不到这张卡；直接扫源码能在提交前抓住任何再次被写坏的文案。
test('ImageEditorCard zh-CN labels are real CJK text, not encoding-lost question marks', () => {
  const source = readFileSync('src/components/ImageEditorCard.tsx', 'utf8')
  const zhBlock = source.slice(source.indexOf('? {') + 3, source.indexOf('  : {'))
  const lost = zhBlock.match(/'[^']*\?[^']*'/g) ?? []
  assert.deepEqual(lost, [])
  assert.match(zhBlock, /[一-鿿]/)
})
