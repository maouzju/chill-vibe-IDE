import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

type ResolveProviderCommandLaunchOptions = {
  command: string
  args: string[]
  platform?: NodeJS.Platform
}

type ProviderCommandLaunch = {
  command: string
  args: string[]
}

const windowsCmdShimPattern = /"%dp0%\\([^"\r\n]+?\.(?:js|cjs|mjs))"/i

const resolveBundledNode = async (commandDir: string) => {
  const bundledNodePath = path.join(commandDir, 'node.exe')

  try {
    await access(bundledNodePath)
    return bundledNodePath
  } catch {
    return 'node'
  }
}

const resolveWindowsCmdShimLaunch = async (
  command: string,
  args: string[],
): Promise<ProviderCommandLaunch> => {
  try {
    const shimSource = await readFile(command, 'utf8')
    const entrypointMatch = shimSource.match(windowsCmdShimPattern)

    if (!entrypointMatch) {
      return { command, args }
    }

    const commandDir = path.dirname(command)
    const nodeCommand = await resolveBundledNode(commandDir)
    const entrypointPath = path.resolve(commandDir, entrypointMatch[1]!.replace(/\\/g, path.sep))

    return {
      command: nodeCommand,
      args: [entrypointPath, ...args],
    }
  } catch {
    return { command, args }
  }
}

export const resolveProviderCommandLaunch = async ({
  command,
  args,
  platform = process.platform,
}: ResolveProviderCommandLaunchOptions): Promise<ProviderCommandLaunch> => {
  if (platform === 'win32' && /\.cmd$/i.test(command)) {
    return resolveWindowsCmdShimLaunch(command, args)
  }

  return { command, args }
}
