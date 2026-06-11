import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

import { ensureWithinWorkspace } from './file-system.js'

type FileWatchListener = () => void

type FileWatchSubscription = {
  directoryKey: string
  fileName: string
  listener: FileWatchListener
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
 */
export class FileWatcherManager {
  private readonly directories = new Map<string, DirectoryWatchEntry>()
  private readonly subscriptions = new Map<string, FileWatchSubscription>()

  subscribe(
    workspacePath: string,
    relativePath: string,
    subscriptionId: string,
    listener: FileWatchListener,
  ): boolean {
    let targetPath: string
    try {
      targetPath = ensureWithinWorkspace(workspacePath, relativePath)
    } catch {
      return false
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
        return false
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
      return false
    }

    entry.subscriptionIds.add(subscriptionId)
    this.subscriptions.set(subscriptionId, { directoryKey, fileName, listener })
    return true
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
        subscription.listener()
      } catch {
        // Listener failures must never break the shared watcher loop.
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
