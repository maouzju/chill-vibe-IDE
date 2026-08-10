import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

const defaultMaxAgeMs = 7 * 24 * 60 * 60 * 1000

// 症状：codex-agent-homes 在 2026-08-10 实测已堆到 1469 个目录 / 39530 个文件 / 16.5 GB，
//       其中 1139 个超过 7 天没再被写过，最早的可追到 2026-07-17。
// 根因：隔离 HOME 每次 Codex 子代理运行都新建一个（server/codex-safety.ts），而全仓库
//       没有任何一处会删除它 —— 只创建、不回收。
// 被否决：进程退出时删自己的目录 —— 应用可能被强杀（本次排查中已多次出现异常终止），
//       退出钩子并不可靠；改为启动新一轮时顺带回收过期的，崩溃也不会漏掉清理。
export const pruneStaleCodexAgentHomes = async ({
  rootDir,
  nowMs,
  maxAgeMs = defaultMaxAgeMs,
  protectedKeys,
}: {
  rootDir: string
  nowMs: number
  maxAgeMs?: number
  protectedKeys?: Iterable<string>
}): Promise<{ removed: number }> => {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => null)
  if (!entries) {
    return { removed: 0 }
  }

  const protectedNames = new Set(protectedKeys ?? [])
  let removed = 0

  for (const entry of entries) {
    // 只回收目录：这个根目录下不该有散落文件，真有也不归回收逻辑处置。
    if (!entry.isDirectory() || protectedNames.has(entry.name)) {
      continue
    }

    const fullPath = path.join(rootDir, entry.name)
    const info = await stat(fullPath).catch(() => null)
    if (!info || nowMs - info.mtimeMs <= maxAgeMs) {
      continue
    }

    // 回收是尽力而为：目录被占用或权限不足时跳过即可，绝不能让一次正常的
    // Codex 启动因为后台清理失败而中断。
    const deleted = await rm(fullPath, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false)

    if (deleted) {
      removed += 1
    }
  }

  return { removed }
}

export const codexAgentHomeRetentionMs = defaultMaxAgeMs
