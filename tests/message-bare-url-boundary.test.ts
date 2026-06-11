import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  normalizeBareUrlBoundaries,
  renderMarkdown,
} from '../src/components/chat-card-rendering.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// GFM autolink-literal trims only ASCII trailing punctuation, so a bare URL
// followed by `**` or CJK fullwidth punctuation swallows those characters into
// the href (`http://127.0.0.1:5273**（dev`), which then fails `new URL()` in the
// main process and the click silently does nothing.

test('normalizeBareUrlBoundaries cuts a bold-wrapped bare URL at the closing **', () => {
  const input = '已在浏览器打开 **http://127.0.0.1:5273**（dev server 还活着，没重启）。'
  assert.equal(
    normalizeBareUrlBoundaries(input),
    '已在浏览器打开 **[http://127.0.0.1:5273](http://127.0.0.1:5273)**（dev server 还活着，没重启）。',
  )
})

test('normalizeBareUrlBoundaries cuts a bare URL at CJK fullwidth punctuation', () => {
  assert.equal(
    normalizeBareUrlBoundaries('访问 http://example.com，然后继续。'),
    '访问 [http://example.com](http://example.com)，然后继续。',
  )
  assert.equal(
    normalizeBareUrlBoundaries('（见 https://example.com/a?b=1）后续'),
    '（见 [https://example.com/a?b=1](https://example.com/a?b=1)）后续',
  )
})

test('normalizeBareUrlBoundaries strips trailing ASCII punctuation left before the cut', () => {
  assert.equal(
    normalizeBareUrlBoundaries('**http://example.com.**（说明）'),
    '**[http://example.com](http://example.com)**（说明）',
  )
})

test('normalizeBareUrlBoundaries leaves clean URLs to the GFM autolink', () => {
  const clean = 'see http://example.com/path?a=1 ok'
  assert.equal(normalizeBareUrlBoundaries(clean), clean)

  const asciiTail = 'see http://example.com, next'
  assert.equal(normalizeBareUrlBoundaries(asciiTail), asciiTail)

  const cjkPath = '词条 https://zh.wikipedia.org/wiki/中文 在这里'
  assert.equal(normalizeBareUrlBoundaries(cjkPath), cjkPath)
})

test('normalizeBareUrlBoundaries keeps CJK path segments while cutting fullwidth tails', () => {
  assert.equal(
    normalizeBareUrlBoundaries('词条 https://zh.wikipedia.org/wiki/中文，结束'),
    '词条 [https://zh.wikipedia.org/wiki/中文](https://zh.wikipedia.org/wiki/中文)，结束',
  )
})

test('normalizeBareUrlBoundaries skips explicit links, autolinks and code spans', () => {
  const explicit = '[打开](http://127.0.0.1:5273**（不是边界)'
  assert.equal(normalizeBareUrlBoundaries(explicit), explicit)

  const angle = '<http://example.com**（x>'
  assert.equal(normalizeBareUrlBoundaries(angle), angle)

  const inlineCode = '执行 `curl http://127.0.0.1:5273**（raw`'
  assert.equal(normalizeBareUrlBoundaries(inlineCode), inlineCode)

  const fenced = '```\nhttp://127.0.0.1:5273**（raw\n```'
  assert.equal(normalizeBareUrlBoundaries(fenced), fenced)
})

test('renderMarkdown renders a bold-wrapped bare URL as a clickable bold link', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown('已在浏览器打开 **http://127.0.0.1:5273**（dev server 还活着，没重启）。'),
    ),
  )

  assert.match(markup, /href="http:\/\/127\.0\.0\.1:5273"/)
  assert.match(markup, /<strong>/)
  assert.doesNotMatch(markup, /5273\*\*/)
  assert.doesNotMatch(markup, /href="[^"]*%EF%BC%88[^"]*"/)
})

test('renderMarkdown keeps fullwidth punctuation out of bare URL hrefs', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      renderMarkdown('访问 http://example.com，然后继续。'),
    ),
  )

  assert.match(markup, /href="http:\/\/example\.com"/)
  assert.doesNotMatch(markup, /href="[^"]*%EF%BC[^"]*"/)
})
