import { getVirtualizedListWindow, type VirtualizedListWindow } from './git-change-windowing'
import type { GitChange } from '../../shared/schema'

const gitDashboardFileListThreshold = 60
const gitDashboardFileListRowHeight = 20
const gitDashboardFileListOverscan = 6

type GitDashboardFileListWindowOptions = {
  changeCount: number
  viewportHeight: number
  scrollTop: number
}

export const getGitDashboardFileListWindow = ({
  changeCount,
  viewportHeight,
  scrollTop,
}: GitDashboardFileListWindowOptions): VirtualizedListWindow =>
  getVirtualizedListWindow({
    itemCount: changeCount,
    itemHeight: gitDashboardFileListRowHeight,
    viewportHeight,
    scrollTop,
    overscan: gitDashboardFileListOverscan,
    threshold: gitDashboardFileListThreshold,
  })

export const getGitDashboardVisibleChanges = (
  changes: GitChange[],
  fileListWindow: VirtualizedListWindow | null,
) => {
  if (!fileListWindow?.isVirtualized) {
    return changes
  }

  return changes.slice(fileListWindow.startIndex, fileListWindow.endIndex)
}
