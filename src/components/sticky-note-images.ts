import type { ImageAttachment } from '../../shared/schema'

// 症状 (2026-11-20 审查): 有图的便签挂载后、磁盘加载完成前就被切走（StrictMode 必然），卸载保存
//   带着 attachments: [] 落盘，服务端整体覆盖 index，图片列表被清空。
// 根因: 挂载时先把附件 ref 清成 []，异步加载完才写回；所有保存路径都不看「还在加载」。
// 否决: 不带 attachments 让服务端保留（schema default([]) 照样覆盖，要改协议）。加载未定时一律不存，
//   正文已经由 onChange 写回卡片状态，不会丢。
export const shouldPersistStickyNoteDocument = ({
  diskLoadPending,
  hasLocalDocument,
  content,
  attachments,
}: {
  diskLoadPending: boolean
  hasLocalDocument: boolean
  content: string
  attachments: readonly ImageAttachment[]
}) => !diskLoadPending && (hasLocalDocument || content.trim().length > 0 || attachments.length > 0)

// 症状 (2026-11-20 审查): 清空便签后 500ms 内点开另一条已存笔记，旧防抖定时器触发，把 '' 写进新笔记。
// 根因: 定时器触发时按 activeNoteIdRef.current 落盘，切换笔记 / 还原版本时没有处理还在途的定时器。
// 否决: 直接 clearTimeout 丢弃会丢用户刚敲的字；切换前必须按旧笔记 id 立刻落盘。
export const resolveStickyNotePendingFlush = ({
  debouncePending,
  checkpointPending,
  latestContent,
}: {
  debouncePending: boolean
  checkpointPending: boolean
  latestContent: string
}): { content: string; checkpoint: boolean; propagateToCard: boolean } | null => {
  if (!debouncePending && !checkpointPending) return null
  return { content: latestContent, checkpoint: checkpointPending, propagateToCard: debouncePending }
}

export const mergeStickyNoteAttachments = (
  current: readonly ImageAttachment[],
  incoming: readonly ImageAttachment[],
  limit: number,
): ImageAttachment[] => {
  const seen = new Set(current.map((attachment) => attachment.id))
  const additions = incoming.filter((attachment) => {
    if (seen.has(attachment.id)) return false
    seen.add(attachment.id)
    return true
  })

  return [...current, ...additions].slice(0, Math.max(0, limit))
}
