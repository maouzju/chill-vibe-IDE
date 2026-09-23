import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { GitToolCard } from '../src/components/GitToolCard.tsx'
import { gitOperationHub } from '../src/components/git-operation-hub.ts'
import { FILE_PATH_CONTEXT_MENU_SELECTOR } from '../src/components/file-path-context-menu.ts'
import type { GitStatus } from '../shared/schema.ts'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const workspacePath = 'D:\\Git\\tale-city'

const seedStatus = (): GitStatus => ({
  workspacePath,
  isRepository: true,
  repoRoot: workspacePath,
  branch: 'main',
  ahead: 0,
  behind: 0,
  hasConflicts: false,
  clean: false,
  summary: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
  changes: [
    {
      path: 'claude/memory/derived-def-snapshot-stale-values.md',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
      addedLines: 15,
      removedLines: 0,
    },
    {
      path: 'docs/design/卡牌设计准则.md',
      kind: 'modified',
      stagedStatus: ' ',
      workingTreeStatus: 'M',
      staged: false,
      conflicted: false,
      addedLines: 0,
      removedLines: 0,
    },
  ],
  description: '',
})

// 2026-09-23：git 卡片的已改动文件列表只是纯文本 span，右键拿不到"打开文件 / 打开文件位置"。
// 聊天转录里的文件行早就靠 data-open-file-path 复用同一套右键菜单，git 卡片必须打上同样的标记，
// 否则用户只能手抄路径再去资源管理器里翻。
test('git card change rows are tagged as openable file paths for the shared right-click menu', () => {
  gitOperationHub.reportStatus(workspacePath, seedStatus())

  const markup = renderToStaticMarkup(
    <GitToolCard
      workspacePath={workspacePath}
      language="zh-CN"
      gitAgentModel="claude-fable-5-1"
      systemPrompt=""
      crossProviderSkillReuseEnabled={false}
      requestedHeight={380}
    />,
  )

  const attributeName = FILE_PATH_CONTEXT_MENU_SELECTOR.replace(/^\[/, '').replace(/\]$/, '')

  assert.match(
    markup,
    new RegExp(`${attributeName}="claude/memory/derived-def-snapshot-stale-values\\.md"`),
  )
  assert.match(markup, new RegExp(`${attributeName}="docs/design/`))
})

// 删掉的文件在磁盘上已经不存在，"打开文件"点下去必然失败；标成 reveal-only 让共享菜单
// 只保留"打开文件位置"（定位到它原来所在的目录）与"复制路径"。
test('deleted files are tagged reveal-only so the menu drops the dead in-editor entry', () => {
  const status = seedStatus()
  status.changes = [
    {
      path: 'docs/design/removed.md',
      kind: 'deleted',
      stagedStatus: ' ',
      workingTreeStatus: 'D',
      staged: false,
      conflicted: false,
    },
  ]
  gitOperationHub.reportStatus(workspacePath, status)

  const markup = renderToStaticMarkup(
    <GitToolCard
      workspacePath={workspacePath}
      language="zh-CN"
      gitAgentModel="claude-fable-5-1"
      systemPrompt=""
      crossProviderSkillReuseEnabled={false}
      requestedHeight={380}
    />,
  )

  assert.match(
    markup,
    /data-open-file-path="docs\/design\/removed\.md" data-open-file-reveal-only="true"/,
  )
})
