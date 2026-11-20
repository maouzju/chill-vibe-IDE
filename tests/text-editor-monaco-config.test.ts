import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTextEditorLanguageId,
  normalizeTextEditorModelPath,
  resolveTextEditorLanguageLoaderId,
  resolveTextEditorModelUriParts,
  resolveTextEditorMonacoTheme,
} from '../src/components/text-editor-monaco-config.ts'

test('text editor maps server language aliases to Monaco-friendly ids', () => {
  assert.equal(normalizeTextEditorLanguageId('typescriptreact'), 'typescript')
  assert.equal(normalizeTextEditorLanguageId('javascriptreact'), 'javascript')
  assert.equal(normalizeTextEditorLanguageId('shellscript'), 'shell')
  assert.equal(normalizeTextEditorLanguageId('dotenv'), 'ini')
  assert.equal(normalizeTextEditorLanguageId('unknown-language'), 'unknown-language')
  assert.equal(normalizeTextEditorLanguageId(''), 'plaintext')
})

test('text editor normalizes Monaco theme names from app theme state', () => {
  assert.equal(resolveTextEditorMonacoTheme('dark'), 'vs-dark')
  assert.equal(resolveTextEditorMonacoTheme('light'), 'vs')
  assert.equal(resolveTextEditorMonacoTheme(undefined), 'vs-dark')
})

test('text editor resolves Monaco loader groups for syntax highlighting bundles', () => {
  assert.equal(resolveTextEditorLanguageLoaderId('markdown'), 'markdown')
  assert.equal(resolveTextEditorLanguageLoaderId('typescriptreact'), 'typescript')
  assert.equal(resolveTextEditorLanguageLoaderId('javascript'), 'typescript')
  assert.equal(resolveTextEditorLanguageLoaderId('yaml'), 'yaml')
  assert.equal(resolveTextEditorLanguageLoaderId('plaintext'), null)
})

test('text editor model paths stay file-like for Monaco URI inference', () => {
  assert.equal(normalizeTextEditorModelPath('src\\App.tsx'), '/src/App.tsx')
  assert.equal(normalizeTextEditorModelPath('/docs/readme.md'), '/docs/readme.md')
  assert.equal(normalizeTextEditorModelPath(''), '/untitled.txt')
})

test('text editor model URIs are workspace-qualified so two worktrees never share a model', () => {
  const none = () => false
  const left = resolveTextEditorModelUriParts('D:\\Git\\repo', 'src\\App.tsx', none)
  const right = resolveTextEditorModelUriParts('D:\\Git\\repo-wt', 'src/App.tsx', none)

  assert.deepEqual(left, { authority: '', path: '/D:/Git/repo/src/App.tsx' })
  assert.deepEqual(right, { authority: '', path: '/D:/Git/repo-wt/src/App.tsx' })
  assert.deepEqual(
    resolveTextEditorModelUriParts('/home/me/repo/', '/docs/readme.md', none),
    { authority: '', path: '/home/me/repo/docs/readme.md' },
  )
})

test('text editor model URI steps aside instead of reusing a URI another editor still owns', () => {
  const taken = new Set(['|/D:/Git/repo/src/App.tsx', 'copy-2|/D:/Git/repo/src/App.tsx'])
  const parts = resolveTextEditorModelUriParts(
    'D:/Git/repo',
    'src/App.tsx',
    ({ authority, path }) => taken.has(`${authority}|${path}`),
  )

  // Same path (extension intact for language/TS-worker inference), distinct authority.
  assert.deepEqual(parts, { authority: 'copy-3', path: '/D:/Git/repo/src/App.tsx' })
})
