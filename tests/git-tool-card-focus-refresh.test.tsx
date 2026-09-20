import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { GitToolCard } from '../src/components/GitToolCard.tsx'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

// 2026-09-20：卡片根节点挂了 onFocus 走 requestAutoRefresh，但根节点本身不可聚焦，
// React 的 onFocus 只能靠子元素（按钮）冒泡；点在文件列表/空白/标题上什么都不触发，
// 用户感受就是"聚焦更新没生效"。根节点必须带 tabIndex=-1 才能让鼠标点到任意位置都收到 focus。
test('GitToolCard root is focusable so clicking anywhere on the card triggers the focus refresh', () => {
  const markup = renderToStaticMarkup(
    <GitToolCard
      workspacePath="D:\Git\chill-vibe"
      language="zh-CN"
      gitAgentModel="claude-fable-5-1"
      systemPrompt=""
      crossProviderSkillReuseEnabled={false}
      requestedHeight={380}
    />,
  )

  const rootMatch = markup.match(/<div[^>]*class="git-tool-card[^"]*"[^>]*>/)
  assert.ok(rootMatch, 'git-tool-card root should render')
  assert.match(rootMatch[0], /tabindex="-1"/)
})
