import * as monaco from 'monaco-editor'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

import {
  normalizeTextEditorLanguageId,
  normalizeTextEditorModelPath,
  resolveTextEditorLanguageLoaderId,
} from './text-editor-monaco-config'

type MonacoTextModel = monaco.editor.ITextModel

type MonacoEnvironmentGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker?: (_workerId: string, label: string) => Worker
  }
}

const textEditorLanguageContributionLoaders: Record<string, () => Promise<unknown>> = {
  cpp: () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'),
  css: () => import('monaco-editor/esm/vs/language/css/monaco.contribution.js'),
  dockerfile: () => import('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js'),
  go: () => import('monaco-editor/esm/vs/basic-languages/go/go.contribution.js'),
  graphql: () => import('monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js'),
  html: () => import('monaco-editor/esm/vs/language/html/monaco.contribution.js'),
  ini: () => import('monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js'),
  java: () => import('monaco-editor/esm/vs/basic-languages/java/java.contribution.js'),
  json: () => import('monaco-editor/esm/vs/language/json/monaco.contribution.js'),
  markdown: () => import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'),
  php: () => import('monaco-editor/esm/vs/basic-languages/php/php.contribution.js'),
  powershell: () => import('monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js'),
  python: () => import('monaco-editor/esm/vs/basic-languages/python/python.contribution.js'),
  rust: () => import('monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js'),
  shell: () => import('monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js'),
  sql: () => import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'),
  typescript: () => import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js'),
  xml: () => import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js'),
  yaml: () => import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
}

const loadedTextEditorLanguageContributions = new Map<string, Promise<void>>()

let monacoEnvironmentConfigured = false

export const ensureTextEditorMonacoEnvironment = () => {
  if (monacoEnvironmentConfigured) {
    return
  }

  const target = globalThis as MonacoEnvironmentGlobal
  target.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      switch (label) {
        case 'json':
          return new jsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        default:
          return new editorWorker()
      }
    },
  }
  monacoEnvironmentConfigured = true
}

export const resolveTextEditorMonacoLanguage = (languageId: string | null | undefined) => {
  const normalized = normalizeTextEditorLanguageId(languageId)
  const loaderId = resolveTextEditorLanguageLoaderId(normalized)
  const isRegistered = monaco.languages.getLanguages().some(({ id }) => id === normalized)
  return loaderId || isRegistered || normalized === 'plaintext'
    ? normalized
    : 'plaintext'
}

export const ensureTextEditorMonacoLanguage = async (languageId: string | null | undefined) => {
  const resolvedLanguage = resolveTextEditorMonacoLanguage(languageId)
  const loaderId = resolveTextEditorLanguageLoaderId(resolvedLanguage)

  if (!loaderId) {
    return resolvedLanguage
  }

  let pending = loadedTextEditorLanguageContributions.get(loaderId)
  if (!pending) {
    pending = textEditorLanguageContributionLoaders[loaderId]()
      .then(() => undefined)
    loadedTextEditorLanguageContributions.set(loaderId, pending)
  }

  await pending
  return resolvedLanguage
}

export const createTextEditorModel = (
  content: string,
  filePath: string,
  languageId: string | null | undefined,
) => {
  return ensureTextEditorMonacoLanguage(languageId)
    .then((resolvedLanguage) => {
      const uri = monaco.Uri.from({
        scheme: 'file',
        path: normalizeTextEditorModelPath(filePath),
      })
      const existingModel = monaco.editor.getModel(uri)
      existingModel?.dispose()
      return monaco.editor.createModel(content, resolvedLanguage, uri)
    })
}

export const replaceTextEditorModelLanguage = async (
  model: MonacoTextModel,
  content: string,
  languageId: string | null | undefined,
) => {
  const resolvedLanguage = await ensureTextEditorMonacoLanguage(languageId)
  model.setValue(content)
  monaco.editor.setModelLanguage(model, resolvedLanguage)
  return model
}

export { monaco }
