import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

import { ensureWithinWorkspace, type WorkspacePathGuardOptions } from './file-system.js'

/** Why an arm attempt did not produce a live watcher. */
export type FileWatchFailureReason =
  /** The requested path resolved outside the workspace root. */
  | 'outside-workspace'
  /** `fs.watch` threw while arming the parent directory (missing dir, EMFILE, ...). */
  | 'watch-failed'
  /** The directory entry vanished between creation and lookup. */
  | 'watcher-lost'

export type FileWatchSubscribeResult =
  | { subscribed: true }
  | { subscribed: false; reason: FileWatchFailureReason }

/** The single cross-process event payload: which subscription saw a change. */
export type FileWatchEvent = { subscriptionId: string }

export type FileWatchEventSink = (event: FileWatchEvent) => void

/**
 * 症状：文件监听登记失败后调用方仍然以为在监听，编辑器永远收不到磁盘变化，
 *   且没有任何报错——静默走错分支。
 * 根因：2026-08-12 后端要整体搬进 utilityProcess（实测同批 git 操作跑在主进程时
 *   窗口单次最长停摆 6827ms / 11 次超 1s，同样操作在 utilityProcess 里只有 58ms），
 *   而进程边界只能传可结构化克隆的数据：旧签名的回调入参跨不过去，同步 `boolean`
 *   返回值跨过去会变成 `Promise`，`if (subscribed)` 于是恒真。
 * 为什么不能换写法：不能只是"保留 boolean，让调用方 await"——漏 await 一处就恢复
 *   成恒真且无声；对象结果让"忘了解包"退化成 `undefined`（fail-closed），三条失败
 *   路径也各自具名，调用方能区分而不是只知道"没成"。
 */
export const isFileWatchArmed = (result: unknown): boolean =>
  typeof result === 'object'
  && result !== null
  && (result as { subscribed?: unknown }).subscribed === true

type FileWatchSubscription = {
  directoryKey: string
  fileName: string
}

type DirectoryWatchEntry = {
  watcher: FSWatcher
  subscriptionIds: Set<string>
}

const normalizeFileName = (value: string) =>
  process.platform === 'win32' ? value.toLowerCase() : value

/**
 * Watches individual workspace files for the text editor. Watchers are armed on
 * the parent directory (single-file fs.watch breaks on the rename-replace saves
 * that editors and git use) and shared between sibling-file subscriptions.
 *
 * Changes are pushed to one process-level sink keyed by `subscriptionId` rather
 * than to per-subscription callbacks, so the whole surface is plain data.
 */
export class FileWatcherManager {
  private readonly directories = new Map<string, DirectoryWatchEntry>()
  private readonly subscriptions = new Map<string, FileWatchSubscription>()
  private readonly emit: FileWatchEventSink

  constructor(emit: FileWatchEventSink) {
    this.emit = emit
  }

  subscribe(
    workspacePath: string,
    relativePath: string,
    subscriptionId: string,
    options?: WorkspacePathGuardOptions,
  ): FileWatchSubscribeResult {
    let targetPath: string
    try {
      targetPath = ensureWithinWorkspace(workspacePath, relativePath, options)
    } catch {
      return { subscribed: false, reason: 'outside-workspace' }
    }

    this.unsubscribe(subscriptionId)

    const directoryKey = path.dirname(targetPath)
    const fileName = normalizeFileName(path.basename(targetPath))

    if (!this.directories.has(directoryKey)) {
      let watcher: FSWatcher
      try {
        watcher = watch(directoryKey, (_eventType, changedName) => {
          this.notifyDirectory(directoryKey, changedName)
        })
      } catch {
        return { subscribed: false, reason: 'watch-failed' }
      }

      watcher.on('error', () => {
        // A broken watcher must not crash the process; subscribers fall back
        // to the renderer's slow polling safety net.
        this.closeDirectory(directoryKey)
      })

      this.directories.set(directoryKey, { watcher, subscriptionIds: new Set() })
    }

    const entry = this.directories.get(directoryKey)
    if (!entry) {
      return { subscribed: false, reason: 'watcher-lost' }
    }

    entry.subscriptionIds.add(subscriptionId)
    this.subscriptions.set(subscriptionId, { directoryKey, fileName })
    return { subscribed: true }
  }

  unsubscribe(subscriptionId: string) {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) {
      return
    }

    this.subscriptions.delete(subscriptionId)

    const entry = this.directories.get(subscription.directoryKey)
    if (!entry) {
      return
    }

    entry.subscriptionIds.delete(subscriptionId)
    if (entry.subscriptionIds.size === 0) {
      this.closeDirectory(subscription.directoryKey)
    }
  }

  dispose() {
    for (const directoryKey of [...this.directories.keys()]) {
      this.closeDirectory(directoryKey)
    }
    this.subscriptions.clear()
  }

  private notifyDirectory(directoryKey: string, changedName: string | Buffer | null) {
    const entry = this.directories.get(directoryKey)
    if (!entry) {
      return
    }

    const normalizedChange = typeof changedName === 'string'
      ? normalizeFileName(changedName)
      : null

    for (const subscriptionId of entry.subscriptionIds) {
      const subscription = this.subscriptions.get(subscriptionId)
      if (!subscription) {
        continue
      }

      // A null filename means the platform could not attribute the event; err
      // toward notifying so a real change is never missed.
      if (normalizedChange !== null && normalizedChange !== subscription.fileName) {
        continue
      }

      try {
        this.emit({ subscriptionId })
      } catch {
        // Sink failures must never break the shared watcher loop.
      }
    }
  }

  private closeDirectory(directoryKey: string) {
    const entry = this.directories.get(directoryKey)
    if (!entry) {
      return
    }

    this.directories.delete(directoryKey)
    try {
      entry.watcher.close()
    } catch {
      // Closing an already-broken watcher is best-effort.
    }
  }
}
