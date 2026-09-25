import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFilePathContextMenuActions,
  isRunnableFilePath,
} from '../src/components/file-path-context-menu.ts'
import { buildLocalFileRunCommandLine } from '../electron/local-file-run.ts'

test('bat/cmd/exe paths are runnable, source files are not', () => {
  assert.equal(isRunnableFilePath('workspace/tools/启动游戏.bat'), true)
  assert.equal(isRunnableFilePath('tools/setup.CMD'), true)
  assert.equal(isRunnableFilePath('C:\\apps\\a.exe'), true)
  assert.equal(isRunnableFilePath('src/App.tsx'), false)
  assert.equal(isRunnableFilePath('bat'), false)
})

test('runnable file gets "直接运行" as the first menu action', () => {
  const actions = buildFilePathContextMenuActions({
    language: 'zh-CN',
    canOpenInEditor: true,
    runnable: true,
  })
  assert.deepEqual(actions[0], { key: 'run', label: '直接运行' })
  const plain = buildFilePathContextMenuActions({ language: 'zh-CN', canOpenInEditor: true })
  assert.equal(plain.some((action) => action.key === 'run'), false)
})

test('run command line launches through start with an empty title', () => {
  assert.equal(
    buildLocalFileRunCommandLine('D:\\Git\\game company\\启动游戏.bat'),
    '/d /s /c "start "" "D:\\Git\\game company\\启动游戏.bat""',
  )
})
