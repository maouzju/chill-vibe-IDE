import { useEffect, useRef, useState, type CSSProperties } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type { AppLanguage } from '../../shared/schema'
import { fetchWeatherData, type WeatherData } from '../api'

type TimePhase = 'morning' | 'noon' | 'evening' | 'night'

function getTimePhase(): TimePhase {
  const h = new Date().getHours()
  if (h >= 5 && h < 10) return 'morning'
  if (h >= 10 && h < 16) return 'noon'
  if (h >= 16 && h < 20) return 'evening'
  return 'night'
}

const REFRESH_INTERVAL_MS = 30 * 60 * 1000
const TIME_PHASE_INTERVAL_MS = 2 * 60 * 1000

// Deterministic pseudo-random durations (avoids Math.random in render)
const RAIN_DURATIONS = [0.58, 0.72, 0.64, 0.76, 0.61, 0.69, 0.78, 0.56, 0.66, 0.62, 0.74, 0.60]
const RAIN_HEIGHTS = [13, 17, 12, 18, 14, 16, 13, 17, 15, 13, 18, 12]
const RAIN_WIDTHS = [1, 1.5, 1, 1.5, 1, 1.5, 1, 1.5, 1, 1, 1.5, 1]
const SNOW_DURATIONS = [3.0, 3.6, 3.2, 2.8, 3.9, 3.1, 3.7, 3.3, 2.9, 3.5]
const SNOW_SIZES = [3, 5, 4, 6, 3, 5, 4, 6, 3, 5]
const SNOW_SWAY = [28, -24, 34, -18, 26, -32, 20, -26, 30, -20]

type WeatherStyle = CSSProperties & Record<`--${string}`, string | number>

// ── Internal visual elements ────────────────────────────────────────────────

function SunGlow() {
  return (
    <div className="weather-sun-glow">
      <div className="weather-sun-rays" />
      <div className="weather-sun-rays weather-sun-rays--slow" />
      <div className="weather-sun-core" />
    </div>
  )
}

function MoonCrescent() {
  return <div className="weather-moon" />
}

const CLOUD_PRESETS = [
  { className: 'weather-cloud weather-cloud--back', top: '8%', left: '-10%', w: 160, h: 70, opacity: 0.35, delay: 0, speed: 28 },
  { className: 'weather-cloud weather-cloud--mid', top: '22%', left: '15%', w: 130, h: 60, opacity: 0.5, delay: 4, speed: 22 },
  { className: 'weather-cloud weather-cloud--front', top: '40%', left: '5%', w: 150, h: 65, opacity: 0.65, delay: 2, speed: 18 },
]

const RAIN_STREAKS = RAIN_DURATIONS.map((duration, i) => ({
  key: `rain-${i}`,
  style: {
    left: `${6 + i * 7.6}%`,
    width: `${RAIN_WIDTHS[i]}px`,
    height: `${RAIN_HEIGHTS[i]}px`,
    animationDelay: `${(i * 0.09) % 0.7}s`,
    animationDuration: `${duration}s`,
  } satisfies CSSProperties,
}))

const SNOW_DOTS = SNOW_DURATIONS.map((duration, i) => {
  const size = SNOW_SIZES[i]
  return {
    key: `snow-${i}`,
    style: {
      left: `${7 + i * 9}%`,
      width: `${size}px`,
      height: `${size}px`,
      opacity: 0.4 + (size / 7) * 0.5,
      animationDelay: `${i * 0.45}s`,
      animationDuration: `${duration}s`,
      '--sway': `${SNOW_SWAY[i]}px`,
    } satisfies WeatherStyle,
  }
})

function CloudLayers({ count }: { count: number }) {
  const layers = CLOUD_PRESETS.slice(0, count)
  return (
    <>
      {layers.map((c, i) => (
        <div
          key={i}
          className={c.className}
          style={{
            width: `${c.w}px`,
            height: `${c.h}px`,
            top: c.top,
            left: c.left,
            opacity: c.opacity,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.speed}s`,
          }}
        />
      ))}
    </>
  )
}

function RainStreaks() {
  return (
    <>
      {RAIN_STREAKS.map(({ key, style }) => (
        <div
          key={key}
          className="weather-rain-streak"
          style={style}
        />
      ))}
    </>
  )
}

function SnowDots() {
  return (
    <>
      {SNOW_DOTS.map(({ key, style }) => (
        <div
          key={key}
          className="weather-snow-dot"
          style={style}
        />
      ))}
    </>
  )
}

function NightStreetScene() {
  return (
    <div className="weather-night-street">
      <MoonCrescent />
      <div className="weather-stars" />
    </div>
  )
}

function renderWeatherVisual(condition: string | undefined, timePhase: TimePhase) {
  if (!condition) return null

  const isNight = timePhase === 'night' || condition === 'clear-night'

  switch (condition) {
    case 'sunny':
      return isNight ? <NightStreetScene /> : <SunGlow />
    case 'clear-night':
      return <NightStreetScene />
    case 'partly-cloudy':
      return (
        <>
          {isNight ? <NightStreetScene /> : <SunGlow />}
          <CloudLayers count={2} />
        </>
      )
    case 'cloudy':
    case 'overcast':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={3} />
        </>
      )
    case 'foggy':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={2} />
          <div className="weather-fog-layer weather-fog-layer--back" />
          <div className="weather-fog-layer weather-fog-layer--mid" />
          <div className="weather-fog-layer weather-fog-layer--front" />
        </>
      )
    case 'drizzle':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={2} />
          <RainStreaks />
        </>
      )
    case 'rainy':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={3} />
          <RainStreaks />
        </>
      )
    case 'thunderstorm':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={3} />
          <RainStreaks />
          <div className="weather-lightning" />
        </>
      )
    case 'snowy':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={2} />
          <SnowDots />
        </>
      )
    case 'windy':
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={2} />
        </>
      )
    default:
      return (
        <>
          {isNight && <NightStreetScene />}
          <CloudLayers count={2} />
        </>
      )
  }
}

// ── Main component ──────────────────────────────────────────────────────────

type WeatherCardProps = {
  language: AppLanguage
  city?: string
}

export function WeatherCard({ language, city }: WeatherCardProps) {
  const text = getLocaleText(language)
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [error, setError] = useState(false)
  const [timePhase, setTimePhase] = useState<TimePhase>(getTimePhase)
  const cardRef = useRef<HTMLDivElement>(null)

  // Fetch weather data on mount and periodically
  useEffect(() => {
    let cancelled = false
    let lastFetchAt = 0

    const doFetch = async () => {
      try {
        const data = await fetchWeatherData(city || undefined)
        if (cancelled) return
        lastFetchAt = Date.now()
        setWeather(data)
        setError(false)
        window.dispatchEvent(
          new CustomEvent('chill-vibe:weather-update', { detail: { weather: data } }),
        )
      } catch {
        if (!cancelled) setError(true)
      }
    }

    void doFetch()
    const handle = setInterval(() => void doFetch(), REFRESH_INTERVAL_MS)

    // Re-fetch when window regains focus after the interval has elapsed
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchAt >= REFRESH_INTERVAL_MS) {
        void doFetch()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      clearInterval(handle)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [city])

  useEffect(() => {
    const handle = setInterval(() => setTimePhase(getTimePhase()), TIME_PHASE_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') setTimePhase(getTimePhase())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(handle)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Dispatch cleanup event on unmount
  useEffect(() => {
    return () => {
      window.dispatchEvent(
        new CustomEvent('chill-vibe:weather-update', { detail: { weather: null } }),
      )
    }
  }, [])

  const conditionClass = weather ? `is-${weather.condition}` : 'is-loading'

  return (
    <div
      ref={cardRef}
      className={`weather-card ${conditionClass} is-${timePhase}`}
      data-weather-card
    >
      <div className="weather-visual">
        {renderWeatherVisual(weather?.condition, timePhase)}
      </div>
      {error && !weather && (
        <span className="weather-status-label">{text.weatherFetchError}</span>
      )}
      {!weather && !error && (
        <span className="weather-status-label">{text.weatherLoading}</span>
      )}
    </div>
  )
}
