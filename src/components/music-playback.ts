// 症状 (2026-11-20 审查): 点歌后几百毫秒内切 tab / 关掉音乐卡，URL 回来后照样在已卸载卡的 Audio 上
//   开播，界面上没有任何入口能停；连点两首时，先点那首的 URL 晚到还会顶掉后点的。
// 根因: playTrackAudio 在 await getMusicSongUrl 之后无条件 audio.src = url / play()，卸载清理只 pause。
// 否决: 只在卸载时 pause 不够（await 晚于清理返回）；每个 await 之后都要先问 gate「这次请求还算数吗」。
export type MusicPlaybackGate = {
  begin: () => number
  isCurrent: (token: number) => boolean
  cancel: () => void
}

export const createMusicPlaybackGate = (): MusicPlaybackGate => {
  let generation = 0
  let cancelled = false

  return {
    begin: () => {
      generation += 1
      return generation
    },
    isCurrent: (token) => !cancelled && token === generation,
    cancel: () => {
      cancelled = true
      generation += 1
    },
  }
}

export type MusicPlaybackAudio = {
  src: string
  play: () => Promise<void>
}

export const playMusicTrackWhenCurrent = async ({
  trackId,
  audio,
  getSongUrl,
  isCurrent,
}: {
  trackId: number
  audio: MusicPlaybackAudio
  getSongUrl: (trackId: number) => Promise<{ url: string | null | undefined }>
  isCurrent: () => boolean
}) => {
  const source = await getSongUrl(trackId)
  if (!source.url || !isCurrent()) return false
  audio.src = source.url
  await audio.play()
  return true
}
