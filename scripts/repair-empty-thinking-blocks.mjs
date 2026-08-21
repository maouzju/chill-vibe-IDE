#!/usr/bin/env node
// 症状：会话中途开始每一轮都 `API Error: 400 ... thinking: each thinking block
//       must contain thinking`，重试 N 次全部同样失败，断线续传兜不住。
// 根因：中转站把上游 thinking 块的正文剥成空串（signature 仍完整，实测 1132~1692B），
//       Claude CLI 原样写进 ~/.claude/projects/<proj>/<session>.jsonl。此后每一轮都会
//       把这条空块当历史回传，Anthropic 侧确定性 400 —— 所以是「一次被剥，会话永久报废」，
//       跟会话时长无关，重试也无意义（400 不是瞬时故障）。
// 为什么不能换写法：signature 是对原文的签名，正文既然丢了就无法补回，只能把整块摘除；
//       保留 signature 的空块反而是触发 400 的那个东西。
//
// 用法：node scripts/repair-empty-thinking-blocks.mjs [--apply] [--dir <projects 根目录>]
// 默认 dry-run，只报告；--apply 才落盘，落盘前对每个改动文件写 .bak-<时间戳> 备份。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const dirIdx = argv.indexOf('--dir')
const root =
  dirIdx >= 0 && argv[dirIdx + 1]
    ? path.resolve(argv[dirIdx + 1])
    : path.join(os.homedir(), '.claude', 'projects')

const isEmptyThinking = (block) =>
  block && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim() === ''

function repairFile(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  let removed = 0
  let emptiedMessages = 0

  const out = lines.map((line) => {
    if (!line.trim()) return line
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      return line
    }
    const content = entry?.message?.content
    if (!Array.isArray(content) || !content.some(isEmptyThinking)) return line

    const kept = content.filter((block) => !isEmptyThinking(block))
    removed += content.length - kept.length
    // 摘光后留空 content 同样会被 API 拒（不许空块数组，空串 text 也不算数），
    // 所以补一条非空占位而不是 ""；直接删整行会断掉 parentUuid 链，不能那么干。
    if (kept.length === 0) {
      emptiedMessages += 1
      kept.push({ type: 'text', text: '(thinking content unavailable)' })
    }
    entry.message.content = kept
    return JSON.stringify(entry)
  })

  if (removed === 0) return null
  if (apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    fs.copyFileSync(file, `${file}.bak-${stamp}`)
    fs.writeFileSync(file, out.join('\n'), 'utf8')
  }
  return { removed, emptiedMessages }
}

function* walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(full)
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) yield full
  }
}

if (!fs.existsSync(root)) {
  console.error(`projects 根目录不存在: ${root}`)
  process.exit(1)
}

let files = 0
let blocks = 0
for (const file of walk(root)) {
  const res = repairFile(file)
  if (!res) continue
  files += 1
  blocks += res.removed
  console.log(
    `${apply ? 'FIXED' : 'WOULD FIX'}  ${res.removed} 块` +
      (res.emptiedMessages ? ` (${res.emptiedMessages} 条消息被摘空，已补 text 占位)` : '') +
      `  ${path.relative(root, file)}`,
  )
}

console.log(`\n${apply ? '已修复' : '待修复'}: ${files} 个会话文件, ${blocks} 个空 thinking 块`)
if (!apply && files > 0) console.log('加 --apply 落盘（会自动备份 .bak-<时间戳>）')
