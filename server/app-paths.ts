import path from 'node:path'

const dataDirEnvKey = 'CHILL_VIBE_DATA_DIR'
const defaultWorkspaceEnvKey = 'CHILL_VIBE_DEFAULT_WORKSPACE'

const resolveConfiguredPath = (value: string | undefined) => {
  const normalized = value?.trim()
  return normalized ? path.resolve(normalized) : null
}

export const getAppDataDir = () =>
  resolveConfiguredPath(process.env[dataDirEnvKey]) ?? path.join(process.cwd(), '.chill-vibe')

export const getStateFilePath = () => path.join(getAppDataDir(), 'state.json')

export const getAttachmentsDir = () => path.join(getAppDataDir(), 'attachments')

export const getDefaultWorkspacePath = () => {
  if (!(defaultWorkspaceEnvKey in process.env)) {
    return process.cwd()
  }

  const configured = resolveConfiguredPath(process.env[defaultWorkspaceEnvKey])
  return configured ?? ''
}
