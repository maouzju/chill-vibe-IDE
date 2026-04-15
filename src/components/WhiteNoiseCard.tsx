import { useEffect, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'
import {
  fetchWhiteNoiseScenes,
  generateWhiteNoiseScene,
  deleteWhiteNoiseScene,
  readAmbientAudioBuffer,
  type NoiseScene,
} from '../api'
import { HeadphonesIcon, PlayIcon, StopIcon, TrashIcon } from './Icons'

// ── Web Audio noise synthesis ───────────────────────────────────────────────

const BUFFER_SECONDS = 10
const CROSSFADE_SECONDS = 0.05 // 50ms crossfade at loop boundary

/** Apply equal-power crossfade at buffer boundaries for seamless looping */
function applyLoopCrossfade(data: Float32Array, sampleRate: number): void {
  const fadeSamples = Math.floor(sampleRate * CROSSFADE_SECONDS)
  if (fadeSamples < 2 || data.length < fadeSamples * 2) return
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples
    // equal-power: cos/sin curve avoids volume dip at midpoint
    const fadeOut = Math.cos(t * Math.PI * 0.5)
    const fadeIn = Math.sin(t * Math.PI * 0.5)
    const tailIdx = data.length - fadeSamples + i
    // blend tail into head
    data[i] = data[i] * fadeIn + data[tailIdx] * fadeOut
  }
  // taper the tail region so the looped crossfade doesn't double up
  for (let i = 0; i < fadeSamples; i++) {
    const t = i / fadeSamples
    data[data.length - fadeSamples + i] *= Math.cos(t * Math.PI * 0.5)
  }
}

/** Normalize buffer peak to target amplitude to prevent clipping */
function normalizeBuffer(data: Float32Array, targetPeak: number = 0.9): void {
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i])
    if (abs > peak) peak = abs
  }
  if (peak > 0 && peak > targetPeak) {
    const scale = targetPeak / peak
    for (let i = 0; i < data.length; i++) data[i] *= scale
  }
}

function createWhiteNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * BUFFER_SECONDS
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  applyLoopCrossfade(data, ctx.sampleRate)
  return buffer
}

function createPinkNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * BUFFER_SECONDS
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.96900 * b2 + w * 0.1538520
    b3 = 0.86650 * b3 + w * 0.3104856
    b4 = 0.55000 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.0168980
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
    b6 = w * 0.115926
  }
  normalizeBuffer(data)
  applyLoopCrossfade(data, ctx.sampleRate)
  return buffer
}

function createBrownNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate * BUFFER_SECONDS
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    last = (last + 0.02 * w) / 1.02
    data[i] = last * 3.5
  }
  normalizeBuffer(data)
  applyLoopCrossfade(data, ctx.sampleRate)
  return buffer
}

// ── Sample-based ambient types ────────────────────────────────────────────
// Synthesized types are generated client-side; everything else is downloaded audio.
const SYNTHESIZED_TYPES = new Set(['white', 'pink', 'brown'])

const sampleBufferCache = new Map<string, AudioBuffer>()

async function loadSampleBuffer(ctx: AudioContext, generator: string, url?: string): Promise<AudioBuffer> {
  const cached = sampleBufferCache.get(generator)
  if (cached) return cached
  // Read audio file contents via IPC (returns Uint8Array from Node Buffer)
  const raw = await readAmbientAudioBuffer(generator, url)
  const arrayBuf = raw instanceof ArrayBuffer ? raw : new Uint8Array(raw as Uint8Array).buffer as ArrayBuffer
  const audioBuf = await ctx.decodeAudioData(arrayBuf)
  sampleBufferCache.set(generator, audioBuf)
  return audioBuf
}

type LayerNode = {
  source: AudioBufferSourceNode
  gain: GainNode
}

function createSynthChain(
  ctx: AudioContext,
  generator: 'white' | 'pink' | 'brown',
  volume: number,
  master: GainNode,
): LayerNode {
  const gain = ctx.createGain()
  gain.gain.value = volume

  let noiseBuffer: AudioBuffer
  switch (generator) {
    case 'white':
      noiseBuffer = createWhiteNoiseBuffer(ctx)
      break
    case 'pink':
      noiseBuffer = createPinkNoiseBuffer(ctx)
      break
    case 'brown':
      noiseBuffer = createBrownNoiseBuffer(ctx)
      break
  }

  const source = ctx.createBufferSource()
  source.buffer = noiseBuffer
  source.loop = true
  source.connect(gain)
  gain.connect(master)
  source.start()

  return { source, gain }
}

function createSampleChain(
  ctx: AudioContext,
  buffer: AudioBuffer,
  volume: number,
  master: GainNode,
): LayerNode {
  const gain = ctx.createGain()
  gain.gain.value = volume

  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.connect(gain)
  gain.connect(master)
  source.start()

  return { source, gain }
}

// ── Component ───────────────────────────────────────────────────────────────

type WhiteNoiseCardProps = {
  language: AppLanguage
}

export function WhiteNoiseCard({ language }: WhiteNoiseCardProps) {
  const text = getLocaleText(language)
  const [scenes, setScenes] = useState<NoiseScene[]>([])
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [masterVolume, setMasterVolume] = useState(0.7)

  const audioContextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const activeLayersRef = useRef<LayerNode[]>([])
  const playIdRef = useRef(0)
  useEffect(() => {
    void fetchWhiteNoiseScenes().then(setScenes).catch(() => {})
  }, [])

  useEffect(() => {
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = masterVolume
    }
  }, [masterVolume])

  useEffect(() => () => {
    stopPlayback()
    if (audioContextRef.current) {
      void audioContextRef.current.close()
    }
  }, [])

  function ensureAudioContext() {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const ctx = new AudioContext()
      audioContextRef.current = ctx
      const master = ctx.createGain()
      master.gain.value = masterVolume
      master.connect(ctx.destination)
      masterGainRef.current = master
    }
    if (audioContextRef.current.state === 'suspended') {
      void audioContextRef.current.resume()
    }
    return { ctx: audioContextRef.current, master: masterGainRef.current! }
  }

  function stopPlayback() {
    playIdRef.current += 1
    for (const layer of activeLayersRef.current) {
      try { layer.source.stop() } catch { /* already stopped */ }
      layer.source.disconnect()
      layer.gain.disconnect()
    }
    activeLayersRef.current = []
    setActiveSceneId(null)
  }

  async function playScene(scene: NoiseScene) {
    stopPlayback()
    if (scene.layers.length === 0) return

    // Set active immediately so the UI shows stop button, preventing duplicate plays
    setActiveSceneId(scene.id)
    const currentPlayId = playIdRef.current
    const { ctx, master } = ensureAudioContext()
    const nodes: LayerNode[] = []

    const cleanupNodes = () => {
      for (const node of nodes) {
        try { node.source.stop() } catch { /* */ }
        node.source.disconnect()
        node.gain.disconnect()
      }
    }

    for (const layer of scene.layers) {
      // Abort if a newer play/stop was triggered while we were loading
      if (playIdRef.current !== currentPlayId) {
        cleanupNodes()
        return
      }

      if (!SYNTHESIZED_TYPES.has(layer.generator)) {
        try {
          const buffer = await loadSampleBuffer(ctx, layer.generator, layer.url)
          if (playIdRef.current !== currentPlayId) {
            cleanupNodes()
            return
          }
          nodes.push(createSampleChain(ctx, buffer, layer.volume, master))
        } catch (err) {
          console.error(`[WhiteNoise] Failed to load sample for ${layer.generator}:`, err)
          // Skip failed layer, continue with others
          continue
        }
      } else {
        nodes.push(createSynthChain(ctx, layer.generator as 'white' | 'pink' | 'brown', layer.volume, master))
      }
    }

    if (playIdRef.current !== currentPlayId) {
      cleanupNodes()
      return
    }

    activeLayersRef.current = nodes
  }

  async function handleGenerate() {
    setGenerating(true)
    setError(null)
    try {
      const updated = await generateWhiteNoiseScene(prompt.trim() || null)
      setScenes(updated)
      setPrompt('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  async function handleDelete(sceneId: string) {
    if (activeSceneId === sceneId) stopPlayback()
    try {
      const updated = await deleteWhiteNoiseScene(sceneId)
      setScenes(updated)
    } catch { /* ignore */ }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (generating) return
    void handleGenerate()
  }

  const activeScene = scenes.find((s) => s.id === activeSceneId)

  return (
    <div className="whitenoise-card">
      <form className="whitenoise-input-bar" onSubmit={handleSubmit}>
        <input
          className="control whitenoise-prompt-input"
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={text.whiteNoisePlaceholder}
          disabled={generating}
        />
        <button type="submit" className="whitenoise-btn is-primary" disabled={generating}>
          {generating ? text.whiteNoiseGenerating : text.whiteNoiseGenerate}
        </button>
      </form>

      {error ? (
        <div className="whitenoise-error">{error}</div>
      ) : null}

      {scenes.length === 0 && !generating ? (
        <div className="whitenoise-empty">
          <HeadphonesIcon className="whitenoise-empty-icon" />
          <div className="whitenoise-empty-title">{text.whiteNoiseEmptyTitle}</div>
          <div className="whitenoise-empty-description">{text.whiteNoiseEmptyDescription}</div>
        </div>
      ) : (
        <div className="whitenoise-scene-list">
          {scenes.map((scene) => {
            const isActive = scene.id === activeSceneId
            return (
              <div key={scene.id} className={`whitenoise-scene-item${isActive ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="whitenoise-scene-play"
                  onClick={() => (isActive ? stopPlayback() : void playScene(scene))}
                  title={isActive ? text.whiteNoiseStop : scene.title}
                >
                  {isActive ? (
                    <StopIcon className="whitenoise-scene-icon" />
                  ) : (
                    <PlayIcon className="whitenoise-scene-icon" />
                  )}
                </button>
                <div className="whitenoise-scene-info">
                  <span className="whitenoise-scene-title">{scene.title}</span>
                  <span className="whitenoise-scene-layers">
                    {scene.layers.map((l) => l.label).join(' · ')}
                  </span>
                </div>
                <button
                  type="button"
                  className="whitenoise-scene-delete"
                  onClick={() => void handleDelete(scene.id)}
                  title={text.whiteNoiseDelete}
                >
                  <TrashIcon className="whitenoise-scene-icon" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {activeScene ? (
        <div className="whitenoise-player-bar">
          <span className="whitenoise-player-label">{text.whiteNoisePlaying}: {activeScene.title}</span>
          <label className="whitenoise-master-volume">
            <span>{text.whiteNoiseMasterVolume}</span>
            <input
              type="range"
              className="whitenoise-volume-range"
              min={0}
              max={1}
              step={0.05}
              value={masterVolume}
              onChange={(e) => setMasterVolume(Number(e.target.value))}
            />
            <span className="whitenoise-volume-value">{Math.round(masterVolume * 100)}%</span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
