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

export type TextEditorModelUriParts = { authority: string; path: string }

// 症状 (2026-11-20 审查): 两个 worktree 列打开同名相对路径（或同列分栏开同一文件），后开的一侧
//   把先开一侧正在用 / 停放着带脏内容的 model 直接 dispose，编辑器变空白、未保存修改丢失。
// 根因: URI 只由相对路径生成，且建 model 前无条件 dispose 同 URI 的旧 model。
// 否决: 碰撞时复用旧 model（两个编辑器共享缓冲，各自保存/停放会互相踩）；换 query 区分（TS worker
//   把 query 拼进文件名，.tsx 识别失效）。所以路径带工作区、碰撞时只换 authority，路径和扩展名不变。
export const resolveTextEditorModelUriParts = (
  workspacePath: string,
  filePath: string,
  isUriTaken: (parts: TextEditorModelUriParts) => boolean,
): TextEditorModelUriParts => {
  const workspace = workspacePath.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')
  const relative = normalizeTextEditorModelPath(filePath)
  const path = workspace ? `/${workspace}${relative}` : relative

  for (let copy = 1; ; copy += 1) {
    const parts = { authority: copy === 1 ? '' : `copy-${copy}`, path }
    if (!isUriTaken(parts)) {
      return parts
    }
  }
}
