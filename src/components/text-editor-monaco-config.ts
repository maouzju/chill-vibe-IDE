const textEditorLanguageAliases: Record<string, string> = {
  dotenv: 'ini',
  ignore: 'plaintext',
  javascriptreact: 'javascript',
  shellscript: 'shell',
  svelte: 'html',
  toml: 'ini',
  typescriptreact: 'typescript',
  vue: 'html',
}

export const normalizeTextEditorLanguageId = (languageId: string | null | undefined) => {
  const normalized = typeof languageId === 'string'
    ? languageId.trim().toLowerCase()
    : ''

  if (!normalized) {
    return 'plaintext'
  }

  return textEditorLanguageAliases[normalized] ?? normalized
}

const textEditorLanguageLoaderIds: Record<string, string> = {
  c: 'cpp',
  cpp: 'cpp',
  css: 'css',
  dockerfile: 'dockerfile',
  go: 'go',
  graphql: 'graphql',
  html: 'html',
  ini: 'ini',
  java: 'java',
  javascript: 'typescript',
  json: 'json',
  markdown: 'markdown',
  php: 'php',
  powershell: 'powershell',
  python: 'python',
  rust: 'rust',
  shell: 'shell',
  sql: 'sql',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
}

export const resolveTextEditorLanguageLoaderId = (languageId: string | null | undefined) => {
  const normalized = normalizeTextEditorLanguageId(languageId)
  return textEditorLanguageLoaderIds[normalized] ?? null
}

export const resolveTextEditorMonacoTheme = (theme: string | null | undefined) =>
  theme === 'light' ? 'vs' : 'vs-dark'

export const normalizeTextEditorModelPath = (filePath: string) => {
  const normalized = filePath.trim().replaceAll('\\', '/')

  if (normalized.length === 0) {
    return '/untitled.txt'
  }

  return normalized.startsWith('/') ? normalized : `/${normalized}`
}
