import { spawn } from 'node:child_process'
import path from 'node:path'
import { stat } from 'node:fs/promises'

// 「直接运行」走 cmd 的 start 而不是 shell.openPath：openPath 不设工作目录，
// 双击 .bat 时习惯写的相对路径（npm start、./game.exe）会在 IDE 安装目录下执行而失败。
// start 的第一个带引号参数是窗口标题，必须先塞一个空标题，否则带空格的路径会被当成标题吞掉。
export const buildLocalFileRunCommandLine = (targetPath: string) =>
  `/d /s /c "start "" "${targetPath}""`

export const runLocalFileTarget = async (targetPath: string) => {
  const targetStats = await stat(targetPath).catch(() => null)

  if (!targetStats || !targetStats.isFile()) {
    throw new Error(`File not found: ${targetPath}`)
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', [buildLocalFileRunCommandLine(targetPath)], {
      cwd: path.dirname(targetPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
