import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createMusicPlaybackGate,
  playMusicTrackWhenCurrent,
} from '../src/components/music-playback.ts'

const createFakeAudio = () => {
  const calls: string[] = []
  return {
    calls,
    audio: {
      set src(value: string) {
        calls.push(`src:${value}`)
      },
      play: async () => {
        calls.push('play')
      },
    },
  }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('music card playback gate', () => {
  it('does not start playback when the card unmounted while the song URL was loading', async () => {
    const gate = createMusicPlaybackGate()
    const { audio, calls } = createFakeAudio()
    const url = deferred<{ url: string }>()

    const token = gate.begin()
    const pending = playMusicTrackWhenCurrent({
      trackId: 1,
      audio,
      getSongUrl: () => url.promise,
      isCurrent: () => gate.isCurrent(token),
    })

    gate.cancel()
    url.resolve({ url: 'https://example.invalid/a.mp3' })

    assert.equal(await pending, false)
    assert.deepEqual(calls, [])
  })

  it('drops a stale URL when the user already picked another track', async () => {
    const gate = createMusicPlaybackGate()
    const { audio, calls } = createFakeAudio()
    const first = deferred<{ url: string }>()
    const second = deferred<{ url: string }>()

    const firstToken = gate.begin()
    const firstPlay = playMusicTrackWhenCurrent({
      trackId: 1,
      audio,
      getSongUrl: () => first.promise,
      isCurrent: () => gate.isCurrent(firstToken),
    })
    const secondToken = gate.begin()
    const secondPlay = playMusicTrackWhenCurrent({
      trackId: 2,
      audio,
      getSongUrl: () => second.promise,
      isCurrent: () => gate.isCurrent(secondToken),
    })

    second.resolve({ url: 'https://example.invalid/second.mp3' })
    assert.equal(await secondPlay, true)
    first.resolve({ url: 'https://example.invalid/first.mp3' })
    assert.equal(await firstPlay, false)

    assert.deepEqual(calls, ['src:https://example.invalid/second.mp3', 'play'])
  })

  it('plays normally when the request is still current', async () => {
    const gate = createMusicPlaybackGate()
    const { audio, calls } = createFakeAudio()
    const token = gate.begin()

    assert.equal(
      await playMusicTrackWhenCurrent({
        trackId: 3,
        audio,
        getSongUrl: async () => ({ url: 'https://example.invalid/c.mp3' }),
        isCurrent: () => gate.isCurrent(token),
      }),
      true,
    )
    assert.deepEqual(calls, ['src:https://example.invalid/c.mp3', 'play'])
  })
})
