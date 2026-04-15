const windowsPathSeparatorPattern = /[\\/]/
const whitespacePattern = /\s/

const isBareWindowsCommand = (command) =>
  !windowsPathSeparatorPattern.test(command) && !whitespacePattern.test(command)

export function resolveSpawnLaunch({
  command,
  args = [],
  platform = process.platform,
  comspec = process.env.ComSpec || 'cmd.exe',
}) {
  if (platform === 'win32' && isBareWindowsCommand(command)) {
    return {
      command: comspec,
      args: ['/d', '/s', '/c', command, ...args],
    }
  }

  return { command, args }
}
