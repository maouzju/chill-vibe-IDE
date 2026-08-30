export function selectReleaseDirsToPrune(
  dirNames: string[],
  keep: number,
  protectedNames?: string[],
): string[]

export function isDirectExecution(moduleUrl: string, argvEntry?: string): boolean

export function createElectronBuilderArgs(
  target: 'zip' | 'nsis' | 'portable',
  outputDirRelative: string,
  electronVersion?: string,
): string[]

export function shouldUseProductionDependencyStaging(
  target: 'zip' | 'nsis' | 'portable',
  dryRun?: boolean,
): boolean

export function createProductionStagingPackageJson(
  rootPackageJson: Record<string, unknown>,
  electronVersion?: string,
): Record<string, unknown>
