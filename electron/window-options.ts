import path from 'path'

export const getTitleBarStyleForPlatform = (platform: NodeJS.Platform) =>
  platform === 'darwin' ? 'hiddenInset' : undefined

export const shouldUseCustomWindowFrameForPlatform = (platform: NodeJS.Platform) =>
  platform === 'win32' || platform === 'linux'

export const shouldRemoveMenuForPlatform = (platform: NodeJS.Platform) =>
  platform !== 'darwin'

export const getWindowIconPathForPlatform = (
  platform: NodeJS.Platform,
  projectRoot: string,
  isDev = false,
) => {
  if (platform === 'darwin') {
    return undefined
  }

  const iconFileName = isDev ? 'icon-dev.png' : 'icon.png'
  return path.join(projectRoot, 'build', iconFileName)
}
