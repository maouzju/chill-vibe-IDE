import assert from 'node:assert/strict'
import test from 'node:test'

import { closeUnclosedMarkdownSpans } from '../src/components/chat-card-rendering.tsx'

test('closeUnclosedMarkdownSpans leaves balanced inline code untouched', () => {
  const input = '正常情况 `code` 闭合后,这段当然可见。'
  assert.equal(closeUnclosedMarkdownSpans(input), input)
})

test('closeUnclosedMarkdownSpans appends a closing backtick for an odd inline span at the very end', () => {
  // Reproduces the live truncation: a streaming reply ends on a lone opening
  // backtick (the closing one has not streamed in yet). Without closing it, the
  // CommonMark parser keeps the rest of the line in an unterminated code context
  // and the tail can disappear from the rendered bubble.
  const input = '真正的根因不是 `'
  assert.equal(closeUnclosedMarkdownSpans(input), '真正的根因不是 ``')
})

test('closeUnclosedMarkdownSpans closes an inline span left open before more prose', () => {
  const input = '我根本没在打 `'
  const out = closeUnclosedMarkdownSpans(input)
  // The original text must survive verbatim as a prefix.
  assert.ok(out.startsWith(input))
  // And the backtick count must now be even so the span is terminated.
  assert.equal((out.match(/`/g) ?? []).length % 2, 0)
})

test('closeUnclosedMarkdownSpans closes an unterminated fenced code block', () => {
  const input = '上面正常\n```\nconst x = 1\n后面没有闭合围栏'
  const out = closeUnclosedMarkdownSpans(input)
  assert.ok(out.startsWith(input))
  // A balanced number of triple-backtick fences (even count of ``` markers).
  const fences = out.match(/```/g) ?? []
  assert.equal(fences.length % 2, 0)
})

test('closeUnclosedMarkdownSpans keeps a closed fenced code block untouched', () => {
  const input = '```\nconst x = 1\n```'
  assert.equal(closeUnclosedMarkdownSpans(input), input)
})

test('closeUnclosedMarkdownSpans does not treat a fence as two inline spans', () => {
  // A lone ``` fence is three backticks (odd) but must be handled as a fence, not
  // "one inline span + a leftover backtick". Closing it adds another fence line,
  // never a single backtick mid-content.
  const input = '说明文字\n```js\ncode line'
  const out = closeUnclosedMarkdownSpans(input)
  assert.ok(out.includes('```js\ncode line'))
  assert.equal((out.match(/```/g) ?? []).length, 2)
})

test('closeUnclosedMarkdownSpans handles the real ask-user tag-name-in-backticks tail', () => {
  const input = '我根本没在打 `<ask-user-question>'
  const out = closeUnclosedMarkdownSpans(input)
  assert.ok(out.startsWith(input))
  assert.equal((out.match(/`/g) ?? []).length % 2, 0)
})

test('closeUnclosedMarkdownSpans closes a fence right before the prose that follows it', () => {
  // Reproduces the screenshot regression: an unterminated ```bash fence is
  // followed by a blank line and several real paragraphs. Appending the closing
  // fence at the very end would swallow all that prose into one code block.
  // The fence must instead be closed right after the fenced content, so the
  // trailing prose renders as normal paragraphs.
  const input = ['解释一下：', '```bash', 'pnpm electron:build:zip', '', '这是正文不该进代码块', '这也是正文'].join('\n')
  const out = closeUnclosedMarkdownSpans(input)
  assert.ok(out.startsWith(input.split('\n').slice(0, 3).join('\n')))
  // Exactly one closing fence is added (two ``` markers total).
  assert.equal((out.match(/```/g) ?? []).length, 2)
  // The closing fence must sit before the prose: split on the closing fence and
  // confirm the prose lives in the after-part, not inside the code block.
  const lines = out.split('\n')
  const firstFence = lines.indexOf('```bash')
  const closingFence = lines.indexOf('```', firstFence + 1)
  assert.ok(closingFence !== -1, 'a closing fence must exist')
  const proseIndex = lines.indexOf('这是正文不该进代码块')
  assert.ok(proseIndex > closingFence, 'prose must come after the closing fence, not inside the code block')
})

test('closeUnclosedMarkdownSpans still appends the fence at the end for a tail still streaming code', () => {
  // The streaming guard: the reply currently ends inside a fence with no blank
  // line + prose boundary after it (the code is still being typed). Here the
  // closing fence must go at the very end so no characters are lost mid-stream.
  const input = '看代码：\n```js\npnpm install'
  const out = closeUnclosedMarkdownSpans(input)
  assert.ok(out.startsWith(input))
  const lines = out.split('\n')
  assert.equal(lines[lines.length - 1], '```')
  assert.equal((out.match(/```/g) ?? []).length, 2)
})
