import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type {
  CcSwitchImportProfile,
  CcSwitchImportRequest,
  CcSwitchImportResponse,
  Provider,
} from '../shared/schema.js'

type SqliteDatabase = {
  prepare: (sql: string) => {
    all: (...parameters: Array<string | number | null>) => unknown[]
  }
  exec: (sql: string) => void
  close: () => void
}

type ProviderRow = {
  id: string
  app_type: string
  name: string
  settings_config: string
  is_current: number | boolean | null
}

type ProviderEndpointRow = {
  provider_id: string
  app_type: string
  url: string
}

type ParsedProviderSettings = {
  apiKey: string
  baseUrl: string
}

const defaultCcSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db')
const defaultCcSwitchSourceLabel = '~/.cc-switch/cc-switch.db'

const trimText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const normalizeBaseUrl = (value: string) => trimText(value).replace(/\/+$/g, '')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readNestedRecord = (record: Record<string, unknown>, key: string) =>
  isRecord(record[key]) ? record[key] : null

const readString = (record: Record<string, unknown>, key: string) => trimText(record[key])

const parseTomlStringValue = (value: string) => {
  const quote = value[0]

  if (quote !== '"' && quote !== "'") {
    return ''
  }

  const body = value.slice(1, value.lastIndexOf(quote))

  if (quote === "'") {
    return body
  }

  return body.replace(/\\(["\\bnfrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'b':
        return '\b'
      case 'f':
        return '\f'
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      default:
        return escaped
    }
  })
}

const extractTomlBaseUrl = (configToml: string) => {
  const match = configToml.match(/^\s*base_url\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*')\s*$/m)
  return match ? normalizeBaseUrl(parseTomlStringValue(match[1])) : ''
}

const parseClaudeSettings = (settingsConfig: Record<string, unknown>): ParsedProviderSettings => {
  const env = readNestedRecord(settingsConfig, 'env') ?? {}

  return {
    apiKey:
      readString(env, 'ANTHROPIC_AUTH_TOKEN') ||
      readString(env, 'ANTHROPIC_API_KEY') ||
      readString(settingsConfig, 'apiKey'),
    baseUrl: normalizeBaseUrl(readString(env, 'ANTHROPIC_BASE_URL')),
  }
}

const parseCodexSettings = (settingsConfig: Record<string, unknown>): ParsedProviderSettings => {
  const auth = readNestedRecord(settingsConfig, 'auth') ?? {}
  const configToml = readString(settingsConfig, 'config')

  return {
    apiKey:
      readString(auth, 'OPENAI_API_KEY') ||
      readString(settingsConfig, 'apiKey') ||
      readString(settingsConfig, 'OPENAI_API_KEY'),
    baseUrl:
      extractTomlBaseUrl(configToml) ||
      normalizeBaseUrl(readString(settingsConfig, 'baseUrl')) ||
      normalizeBaseUrl(readString(auth, 'OPENAI_BASE_URL')),
  }
}

const parseProviderSettings = (
  provider: Provider,
  rawSettingsConfig: string,
): ParsedProviderSettings => {
  let settingsConfig: Record<string, unknown> = {}

  try {
    const parsed = JSON.parse(rawSettingsConfig) as unknown
    settingsConfig = isRecord(parsed) ? parsed : {}
  } catch {
    settingsConfig = {}
  }

  return provider === 'claude'
    ? parseClaudeSettings(settingsConfig)
    : parseCodexSettings(settingsConfig)
}

const loadSqliteModule = async () => {
  try {
    // String concatenation prevents esbuild from stripping the `node:` prefix
    // during bundling.  Without this, the bundled output resolves to a bare
    // `require("sqlite")` which looks for an npm package instead of the
    // Node built-in module.
    const moduleName = 'node:' + 'sqlite'
    return (await import(/* @vite-ignore */ moduleName)) as typeof import('node:sqlite')
  } catch {
    throw new Error('This runtime cannot read cc-switch databases. Please use a newer Node/Electron build.')
  }
}

const readProviderRows = (database: SqliteDatabase): ProviderRow[] =>
  database
    .prepare(
      `SELECT id, app_type, name, settings_config, is_current
       FROM providers
       WHERE app_type IN ('claude', 'codex')
       ORDER BY app_type ASC, COALESCE(sort_index, 999999) ASC, created_at ASC, id ASC`,
    )
    .all()
    .map((row) => row as ProviderRow)

const readProviderEndpoints = (database: SqliteDatabase) => {
  const endpointRows = database
    .prepare(
      `SELECT provider_id, app_type, url
       FROM provider_endpoints
       WHERE app_type IN ('claude', 'codex')
       ORDER BY COALESCE(added_at, 0) ASC, url ASC`,
    )
    .all()
    .map((row) => row as ProviderEndpointRow)

  const firstEndpointByProvider = new Map<string, string>()

  for (const endpoint of endpointRows) {
    const key = `${endpoint.app_type}:${endpoint.provider_id}`

    if (!firstEndpointByProvider.has(key)) {
      firstEndpointByProvider.set(key, normalizeBaseUrl(endpoint.url))
    }
  }

  return firstEndpointByProvider
}

const extractProfilesFromDatabase = (database: SqliteDatabase): CcSwitchImportProfile[] => {
  const providerRows = readProviderRows(database)
  const firstEndpointByProvider = readProviderEndpoints(database)

  return providerRows.flatMap((row) => {
    const provider = row.app_type === 'claude' ? 'claude' : row.app_type === 'codex' ? 'codex' : null

    if (!provider) {
      return []
    }

    const parsedSettings = parseProviderSettings(provider, row.settings_config)
    const baseUrl =
      parsedSettings.baseUrl || firstEndpointByProvider.get(`${provider}:${row.id}`) || ''
    const name = trimText(row.name) || `${provider === 'claude' ? 'Claude' : 'Codex'} Import`

    return [
      {
        sourceId: row.id,
        provider,
        name,
        apiKey: parsedSettings.apiKey,
        baseUrl,
        active: row.is_current === true || row.is_current === 1,
      },
    ]
  })
}

const readProfilesFromDatabasePath = async (
  databasePath: string,
): Promise<CcSwitchImportProfile[]> => {
  const { DatabaseSync } = await loadSqliteModule()
  const database = new DatabaseSync(databasePath, { readOnly: true })

  try {
    return extractProfilesFromDatabase(database)
  } finally {
    database.close()
  }
}

const readProfilesFromSqlText = async (sqlText: string): Promise<CcSwitchImportProfile[]> => {
  const { DatabaseSync } = await loadSqliteModule()
  const database = new DatabaseSync(':memory:')

  try {
    database.exec(sqlText)
    return extractProfilesFromDatabase(database)
  } finally {
    database.close()
  }
}

const withUploadedTempFile = async <T>(fileName: string, fileData: Buffer, task: (filePath: string) => Promise<T>) => {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chill-vibe-cc-switch-'))
  const tempFilePath = path.join(tempDirectory, path.basename(fileName) || 'cc-switch-import.db')

  try {
    await writeFile(tempFilePath, fileData)
    return await task(tempFilePath)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

const getUploadExtension = (fileName: string) => path.extname(fileName).toLowerCase()

const readUploadedProfiles = async (request: CcSwitchImportRequest) => {
  const fileName = trimText(request.fileName)
  const extension = getUploadExtension(fileName)
  const fileData = Buffer.from(request.dataBase64 ?? '', 'base64')

  if (extension === '.sql') {
    return {
      source: fileName,
      importedProfiles: await readProfilesFromSqlText(fileData.toString('utf8')),
    }
  }

  if (extension !== '.db') {
    throw new Error('Please select a cc-switch .db database or .sql export file.')
  }

  return {
    source: fileName,
    importedProfiles: await withUploadedTempFile(fileName, fileData, readProfilesFromDatabasePath),
  }
}

export const importCcSwitchProfiles = async (
  request: CcSwitchImportRequest,
): Promise<CcSwitchImportResponse> => {
  if (request.mode === 'default') {
    try {
      await access(defaultCcSwitchDbPath)
    } catch {
      throw new Error('Could not find ~/.cc-switch/cc-switch.db on this machine.')
    }

    const importedProfiles = await readProfilesFromDatabasePath(defaultCcSwitchDbPath)

    if (importedProfiles.length === 0) {
      throw new Error('No Claude or Codex providers were found in ~/.cc-switch/cc-switch.db.')
    }

    return {
      source: defaultCcSwitchSourceLabel,
      importedProfiles,
    }
  }

  const result = await readUploadedProfiles(request)

  if (result.importedProfiles.length === 0) {
    throw new Error('No Claude or Codex providers were found in that cc-switch export.')
  }

  return result
}
