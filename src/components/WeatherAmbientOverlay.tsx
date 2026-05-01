import { useEffect, useRef, useState } from 'react'

import type { WeatherData } from '../api'

type TimePhase = 'morning' | 'noon' | 'evening' | 'night'

function getTimePhase(): TimePhase {
  const h = new Date().getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 10 && h < 16) return 'noon'
  if (h >= 16 && h < 20) return 'evening'
  return 'night'
}

type AmbientStyle = { color: string; opacity: number }

const ambientStyles: Record<string, Record<TimePhase, AmbientStyle>> = {
  sunny: {
    morning: { color: 'rgba(255, 200, 80, 1)', opacity: 0.12 },
    noon: { color: 'rgba(255, 230, 120, 1)', opacity: 0.10 },
    evening: { color: 'rgba(255, 160, 60, 1)', opacity: 0.14 },
    night: { color: 'rgba(60, 80, 160, 1)', opacity: 0.08 },
  },
  'clear-night': {
    morning: { color: 'rgba(80, 100, 180, 1)', opacity: 0.06 },
    noon: { color: 'rgba(80, 100, 180, 1)', opacity: 0.06 },
    evening: { color: 'rgba(60, 70, 140, 1)', opacity: 0.08 },
    night: { color: 'rgba(40, 50, 120, 1)', opacity: 0.10 },
  },
  'partly-cloudy': {
    morning: { color: 'rgba(220, 190, 100, 1)', opacity: 0.08 },
    noon: { color: 'rgba(200, 200, 150, 1)', opacity: 0.07 },
    evening: { color: 'rgba(200, 150, 80, 1)', opacity: 0.10 },
    night: { color: 'rgba(60, 70, 120, 1)', opacity: 0.06 },
  },
  cloudy: {
    morning: { color: 'rgba(160, 170, 190, 1)', opacity: 0.06 },
    noon: { color: 'rgba(150, 160, 180, 1)', opacity: 0.05 },
    evening: { color: 'rgba(140, 150, 170, 1)', opacity: 0.08 },
    night: { color: 'rgba(80, 90, 120, 1)', opacity: 0.06 },
  },
  overcast: {
    morning: { color: 'rgba(140, 150, 170, 1)', opacity: 0.07 },
    noon: { color: 'rgba(130, 140, 160, 1)', opacity: 0.06 },
    evening: { color: 'rgba(120, 130, 150, 1)', opacity: 0.09 },
    night: { color: 'rgba(70, 80, 110, 1)', opacity: 0.07 },
  },
  drizzle: {
    morning: { color: 'rgba(100, 140, 190, 1)', opacity: 0.08 },
    noon: { color: 'rgba(110, 140, 180, 1)', opacity: 0.07 },
    evening: { color: 'rgba(80, 110, 160, 1)', opacity: 0.10 },
    night: { color: 'rgba(50, 70, 130, 1)', opacity: 0.08 },
  },
  rainy: {
    morning: { color: 'rgba(80, 120, 180, 1)', opacity: 0.10 },
    noon: { color: 'rgba(90, 120, 170, 1)', opacity: 0.08 },
    evening: { color: 'rgba(60, 100, 150, 1)', opacity: 0.12 },
    night: { color: 'rgba(40, 60, 120, 1)', opacity: 0.10 },
  },
  thunderstorm: {
    morning: { color: 'rgba(100, 60, 160, 1)', opacity: 0.12 },
    noon: { color: 'rgba(90, 70, 140, 1)', opacity: 0.10 },
    evening: { color: 'rgba(80, 50, 140, 1)', opacity: 0.14 },
    night: { color: 'rgba(60, 40, 120, 1)', opacity: 0.12 },
  },
  snowy: {
    morning: { color: 'rgba(200, 210, 240, 1)', opacity: 0.08 },
    noon: { color: 'rgba(220, 225, 245, 1)', opacity: 0.06 },
    evening: { color: 'rgba(170, 180, 220, 1)', opacity: 0.10 },
    night: { color: 'rgba(120, 140, 200, 1)', opacity: 0.08 },
  },
  foggy: {
    morning: { color: 'rgba(180, 185, 195, 1)', opacity: 0.08 },
    noon: { color: 'rgba(170, 175, 185, 1)', opacity: 0.06 },
    evening: { color: 'rgba(150, 155, 170, 1)', opacity: 0.09 },
    night: { color: 'rgba(90, 100, 130, 1)', opacity: 0.07 },
  },
  windy: {
    morning: { color: 'rgba(160, 180, 200, 1)', opacity: 0.06 },
    noon: { color: 'rgba(150, 170, 190, 1)', opacity: 0.05 },
    evening: { color: 'rgba(130, 150, 175, 1)', opacity: 0.07 },
    night: { color: 'rgba(70, 85, 120, 1)', opacity: 0.06 },
  },
}

function getAmbientStyle(condition: string, phase: TimePhase): AmbientStyle {
  return ambientStyles[condition]?.[phase] ?? ambientStyles.cloudy[phase]
}

function useWeatherEvent() {
  const [weather, setWeather] = useState<WeatherData | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { weather: WeatherData | null }
      setWeather(detail.weather)
    }
    window.addEventListener('chill-vibe:weather-update', handler)
    return () => window.removeEventListener('chill-vibe:weather-update', handler)
  }, [])

  return weather
}

function useCardRect(active: boolean) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const rectSignatureRef = useRef('')

  useEffect(() => {
    if (!active) return
    let frame = 0

    const track = () => {
      const el = document.querySelector('[data-weather-card]')
      const nextRect = el?.getBoundingClientRect() ?? null
      const nextSignature = nextRect
        ? `${Math.round(nextRect.left)},${Math.round(nextRect.top)},${Math.round(nextRect.width)},${Math.round(nextRect.height)}`
        : 'none'

      if (rectSignatureRef.current !== nextSignature) {
        rectSignatureRef.current = nextSignature
        setRect(nextRect)
      }
    }
    const scheduleTrack = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        track()
      })
    }

    scheduleTrack()
    window.addEventListener('resize', scheduleTrack)
    window.addEventListener('scroll', scheduleTrack, true)
    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
      }
      window.removeEventListener('resize', scheduleTrack)
      window.removeEventListener('scroll', scheduleTrack, true)
    }
  }, [active])

  return active ? rect : null
}

export function WeatherAmbientOverlay() {
  const weather = useWeatherEvent()
  const cardRect = useCardRect(weather !== null)
  const [timePhase, setTimePhase] = useState<TimePhase>(getTimePhase)

  useEffect(() => {
    const handle = setInterval(() => setTimePhase(getTimePhase()), 2 * 60 * 1000)
    return () => clearInterval(handle)
  }, [])

  if (!weather || !cardRect) return null

  const { color, opacity } = getAmbientStyle(weather.condition, timePhase)
  const cx = cardRect.left + cardRect.width / 2
  const cy = cardRect.top + cardRect.height / 2

  const isRaining = ['rainy', 'drizzle', 'thunderstorm'].includes(weather.condition)

  return (
    <>
      <div
        className="weather-ambient-glow"
        style={{
          background: `radial-gradient(ellipse 800px 600px at ${cx}px ${cy}px, ${color}, transparent)`,
          opacity,
        }}
      />
      {isRaining && <div className="weather-ambient-rain" />}
    </>
  )
}
