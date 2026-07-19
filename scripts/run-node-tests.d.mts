export function parseRegisteredTestFiles(source: string): string[]

export function resolveFocusedTestFiles(
  registeredFiles: string[],
  requestedFiles: string[],
): string[]

export function resolveDefaultConcurrency(
  platform?: NodeJS.Platform,
  available?: number,
): number

export function createNodeTestArgs(
  files: string[],
  concurrency: number,
  forceExit?: boolean,
): string[]

export function detectNodeTestForceExitSupport(
  execPath?: string,
  probe?: (
    command: string,
    args: string[],
    options: { stdio: 'ignore'; windowsHide: boolean },
  ) => { status: number | null; error?: Error },
): boolean

export function isDirectExecution(moduleUrl: string, argvEntry?: string): boolean
