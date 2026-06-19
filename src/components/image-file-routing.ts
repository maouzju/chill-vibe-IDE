export const imageFileMimeTypesByExtension = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
])

export const getImageFileExtension = (filePath: string): string => {
  const normalized = filePath.trim().replace(/\\/g, '/')
  const fileName = normalized.split('/').pop() ?? ''
  const dotIndex = fileName.lastIndexOf('.')

  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

export const getImageFileMimeType = (filePath: string): string | null =>
  imageFileMimeTypesByExtension.get(getImageFileExtension(filePath)) ?? null

export const isImageFilePath = (filePath: string): boolean => getImageFileMimeType(filePath) !== null
