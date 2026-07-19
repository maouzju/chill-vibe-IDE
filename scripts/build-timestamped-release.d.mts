export function selectReleaseDirsToPrune(
  dirNames: string[],
  keep: number,
  protectedNames?: string[],
): string[]

export function isDirectExecution(moduleUrl: string, argvEntry?: string): boolean

export function createElectronBuilderArgs(
  target: 'zip' | 'nsis' | 'portable',
  outputDirRelative: string,
): string[]
