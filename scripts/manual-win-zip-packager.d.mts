export const WINDOWS_ZIP_ROOT_FOLDER_NAME: string

export function resolveZipEntryName(
  sourceDir: string,
  filePath: string,
  rootEntryName?: string,
): string

export function writeZipFromDirectory(
  sourceDir: string,
  zipPath: string,
  rootEntryName?: string,
): void

export function packageManualWindowsZip(input: {
  projectRoot: string
  outputDirAbsolute: string
  version: string
}): {
  zipPath: string
  winUnpackedDir: string
}
