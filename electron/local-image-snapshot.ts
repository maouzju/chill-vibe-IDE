import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

export const getLocalImageSnapshotKey = (requestUrl: string): string | null => {
  try {
    return new URL(requestUrl).searchParams.get('snapshot')?.trim() || null
  } catch {
    return null
  }
}

const snapshotFileName = (snapshotKey: string, target: string) =>
  `${createHash('sha256').update(`${snapshotKey}\0${target}`).digest('hex').slice(0, 40)}${path.extname(target).toLowerCase()}`

const exists = (filePath: string) => stat(filePath).then(() => true, () => false)

// 症状：Agent 贴过的图，之后文件被覆盖/改写，前面老消息里的图跟着变。
// 根因：消息里存的只是本地路径，每次渲染都实时读盘。
// 为什么不改消息文本：消息会被续传/fork 回灌给模型，改写路径会污染对话；按 (消息 id + 路径)
// 在用户数据目录落一份拷贝，文件存在即快照存在，无需额外索引文件。
export const resolveSnapshotImagePath = async ({
  snapshotDir,
  snapshotKey,
  target,
}: {
  snapshotDir: string
  snapshotKey: string
  target: string
}): Promise<string | null> => {
  const snapshotPath = path.join(snapshotDir, snapshotFileName(snapshotKey, target))

  if (await exists(snapshotPath)) {
    return snapshotPath
  }

  if (!(await exists(target))) {
    return null
  }

  // 先拷到临时名再 rename：进程中途被杀时，最终名下永远不会留下半截文件被当成快照服务。
  const partialPath = `${snapshotPath}.${randomUUID()}.partial`
  try {
    await mkdir(snapshotDir, { recursive: true })
    await copyFile(target, partialPath)
    await rename(partialPath, snapshotPath)
    return snapshotPath
  } catch {
    await unlink(partialPath).catch(() => {})
    // 拷贝失败（磁盘满/权限）时退回实时读盘，总比裂图强。
    return target
  }
}

export const pruneImageSnapshots = async (snapshotDir: string, maxAgeMs: number) => {
  let names: string[]
  try {
    names = await readdir(snapshotDir)
  } catch {
    return
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(snapshotDir, name)
      try {
        if ((await stat(filePath)).birthtimeMs < cutoff) {
          await unlink(filePath)
        }
      } catch {
        // best-effort
      }
    }),
  )
}
