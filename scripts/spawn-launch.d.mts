export type SpawnLaunchRequest = {
  command: string
  args?: string[]
  platform?: NodeJS.Platform
  comspec?: string
}

export type SpawnLaunchResult = {
  command: string
  args: string[]
}

export function resolveSpawnLaunch(request: SpawnLaunchRequest): SpawnLaunchResult
