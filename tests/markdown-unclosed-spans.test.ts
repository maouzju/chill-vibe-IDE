import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  closeUnclosedMarkdownSpans,
  renderMarkdown,
  stripLeakedClaudeToolXmlFromMarkdown,
} from '../src/components/chat-card-rendering.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

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


test('closeUnclosedMarkdownSpans closes an unterminated strong span at the streaming tail', () => {
  const input = 'broken copy -> **fix'
  assert.equal(closeUnclosedMarkdownSpans(input), 'broken copy -> **fix**')
})

test('closeUnclosedMarkdownSpans normalizes loose strong markers that AI often streams', () => {
  const input = '- ** fix **\n\nLabel:** keep this plain.'
  assert.equal(
    closeUnclosedMarkdownSpans(input),
    '- **fix**\n\nLabel:** keep this plain.',
  )
})

test('closeUnclosedMarkdownSpans does not auto-close glob patterns as emphasis', () => {
  const input = 'Search files: **/*.ts'
  assert.equal(closeUnclosedMarkdownSpans(input), input)
})


test('renderMarkdown renders AI loose and trailing strong markers as bold text', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown('- ** fix **\n\nbroken copy -> **fix'),
    ),
  )

  assert.equal((markup.match(/<strong>/g) ?? []).length, 2)
  assert.doesNotMatch(markup, /\*\*\s*fix/)
})

test('renderMarkdown hides leaked Claude parameter XML instead of showing count', () => {
  const content = [
    '刚才那次又被当成文本吐出来了。',
    '',
    '<parameter name="output_mode">count</parameter>',
    '',
    '我换用单个工具调用。',
  ].join('\n')

  assert.equal(
    stripLeakedClaudeToolXmlFromMarkdown(content),
    ['刚才那次又被当成文本吐出来了。', '', '', '', '我换用单个工具调用。'].join('\n'),
  )

  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown(content),
    ),
  )

  assert.match(markup, /刚才那次又被当成文本吐出来了/)
  assert.match(markup, /我换用单个工具调用/)
  assert.doesNotMatch(markup, /count/)
  assert.doesNotMatch(markup, /parameter/)
})

test('renderMarkdown hides unterminated leaked Claude tool XML instead of showing count', () => {
  const content = [
    '现在改发射音调用点。',
    '',
    '<function_calls>',
    '  <invoke name="Grep">',
    '    <parameter name="output_mode">count',
  ].join('\n')

  const cleaned = stripLeakedClaudeToolXmlFromMarkdown(content)

  assert.equal(cleaned, '现在改发射音调用点。\n\n')

  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown(content),
    ),
  )

  assert.match(markup, /现在改发射音调用点/)
  assert.doesNotMatch(markup, /count/)
  assert.doesNotMatch(markup, /function_calls/)
  assert.doesNotMatch(markup, /parameter/)
})

test('renderMarkdown keeps backtick-prefixed Claude XML tag mentions as prose', () => {
  const content = '解释：`<invoke name="Bash">` 这里只是在说标签，不是真工具调用。'

  assert.equal(stripLeakedClaudeToolXmlFromMarkdown(content), content)

  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown(content),
    ),
  )

  assert.match(markup, /invoke name=&quot;Bash&quot;/)
  assert.match(markup, /这里只是在说标签/)
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

test('renderMarkdown repairs an inline-code span split across a blank line instead of exposing raw backticks', () => {
  // Screenshot regression: a provider reply placed the opening backtick after
  // the first CJK character, then inserted a blank line before the rest of the
  // sentence. CommonMark cannot carry an inline-code span across that block
  // boundary, so both backticks rendered literally and "卧室" looked torn in
  // half with a large blank region between the two fragments.
  const content = [
    '- **根因**',
    '  - 卧`',
    '',
    '室同时塞入床、衣柜、书架、书桌，最后落到 PowerHandset.gd`，现有床尺寸与双通道冲突。',
  ].join('\n')

  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown(content),
    ),
  )

  assert.match(
    markup,
    /卧<code>室同时塞入床、衣柜、书架、书桌，最后落到 PowerHandset\.gd<\/code>，现有床尺寸与双通道冲突。/,
  )
  assert.doesNotMatch(markup, /卧`/)
  assert.doesNotMatch(markup, /PowerHandset\.gd`/)
  assert.doesNotMatch(markup, /<\/ul>\n<p>室同时/)
})

test('renderMarkdown does not join paragraphs whose inline-code spans are already balanced', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown('第一段 `done`\n\n第二段 `other`'),
    ),
  )

  assert.equal(
    markup,
    '<p>第一段 <code>done</code></p>\n<p>第二段 <code>other</code></p>',
  )
})

test('assistant markdown collapses source whitespace instead of inheriting pre-wrap from the message shell', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

  assert.match(
    css,
    /\.message-assistant\s+\.message-content\s*\{[^}]*white-space:\s*normal\s*;/s,
  )
})
