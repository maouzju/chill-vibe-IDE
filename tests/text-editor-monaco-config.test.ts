import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTextEditorLanguageId,
  normalizeTextEditorModelPath,
  resolveTextEditorLanguageLoaderId,
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
