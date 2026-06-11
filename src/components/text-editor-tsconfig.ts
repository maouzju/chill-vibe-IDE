// Maps raw tsconfig compilerOptions strings onto Monaco's numeric enums.
// The literals mirror monaco-editor's languages.typescript.ScriptTarget,
// ModuleKind, JsxEmit, and ModuleResolutionKind so this module stays
// importable in plain node tests without pulling in Monaco itself.

const scriptTargets: Record<string, number> = {
  es3: 0,
  es5: 1,
  es6: 2,
  es2015: 2,
  es2016: 3,
  es2017: 4,
  es2018: 5,
  es2019: 6,
  es2020: 7,
  es2021: 8,
  es2022: 9,
  esnext: 99,
  latest: 99,
}

const moduleKinds: Record<string, number> = {
  none: 0,
  commonjs: 1,
  amd: 2,
  umd: 3,
  system: 4,
  es6: 5,
  es2015: 5,
  es2020: 99,
  es2022: 99,
  esnext: 99,
  node16: 99,
  nodenext: 99,
}

const jsxEmits: Record<string, number> = {
  none: 0,
  preserve: 1,
  react: 2,
  'react-native': 3,
  'react-jsx': 4,
  'react-jsxdev': 5,
}

const moduleResolutions: Record<string, number> = {
  classic: 1,
  node: 2,
  node10: 2,
  node16: 2,
  nodenext: 2,
  bundler: 2,
}

const booleanFields = [
  'strict',
  'esModuleInterop',
  'allowJs',
  'checkJs',
  'skipLibCheck',
  'allowSyntheticDefaultImports',
  'resolveJsonModule',
  'noImplicitAny',
  'strictNullChecks',
] as const

const lookupEnum = (table: Record<string, number>, value: unknown): number | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  return table[value.trim().toLowerCase()]
}

export const mapTsconfigToMonacoCompilerOptions = (
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {}

  if (!raw || typeof raw !== 'object') {
    return mapped
  }

  const target = lookupEnum(scriptTargets, raw.target)
  if (target !== undefined) {
    mapped.target = target
  }

  const moduleKind = lookupEnum(moduleKinds, raw.module)
  if (moduleKind !== undefined) {
    mapped.module = moduleKind
  }

  const jsx = lookupEnum(jsxEmits, raw.jsx)
  if (jsx !== undefined) {
    mapped.jsx = jsx
  }

  const moduleResolution = lookupEnum(moduleResolutions, raw.moduleResolution)
  if (moduleResolution !== undefined) {
    mapped.moduleResolution = moduleResolution
  }

  for (const field of booleanFields) {
    if (typeof raw[field] === 'boolean') {
      mapped[field] = raw[field]
    }
  }

  if (typeof raw.baseUrl === 'string') {
    mapped.baseUrl = raw.baseUrl
  }

  if (raw.paths && typeof raw.paths === 'object' && !Array.isArray(raw.paths)) {
    mapped.paths = raw.paths
  }

  return mapped
}
