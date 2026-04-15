import type { WeatherCondition, WeatherData } from '../../shared/schema.js'

type CacheEntry = { data: WeatherData; expiresAt: number }
type WeatherLocation = { city: string; latitude: number; longitude: number }
export type CitySuggestion = { name: string; country: string; admin1: string; latitude: number; longitude: number }
type WttrResponse = {
  current_condition?: Array<Record<string, unknown>>
  weather?: Array<{
    astronomy?: Array<Record<string, unknown>>
  }>
  nearest_area?: Array<{
    areaName?: Array<{
      value?: string
    }>
  }>
}
type LocationCandidate = WeatherLocation & {
  country: string
  admin1: string
  score: number
  sourceQuality: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000
const REQUEST_HEADERS = { 'User-Agent': 'chill-vibe-ide' }
const OPEN_METEO_GEOCODE_LIMIT = 5
const NOMINATIM_LIMIT = 5
const OPEN_METEO_LOW_CONFIDENCE_SCORE = 60

const OPEN_METEO_FEATURE_SCORES: Record<string, number> = {
  PPLC: 90,
  PPLA: 80,
  PPLA2: 75,
  PPLA3: 70,
  PPLA4: 65,
  PPLA5: 60,
  PPLL: 55,
  PPLG: 50,
  PPLF: 45,
  PPL: 35,
}

const NOMINATIM_SCOPE_SCORES: Record<string, number> = {
  city: 90,
  town: 82,
  municipality: 78,
  borough: 72,
  county: 62,
  state: 55,
  province: 55,
  suburb: 40,
  village: 28,
  hamlet: 18,
}

// wttr.in weather code → WeatherCondition
const codeMap: Record<string, WeatherCondition> = {
  '113': 'sunny',
  '116': 'partly-cloudy',
  '119': 'cloudy',
  '122': 'overcast',
  '143': 'foggy',
  '176': 'drizzle',
  '179': 'snowy',
  '182': 'drizzle',
  '185': 'drizzle',
  '200': 'thunderstorm',
  '227': 'snowy',
  '230': 'snowy',
  '248': 'foggy',
  '260': 'foggy',
  '263': 'drizzle',
  '266': 'drizzle',
  '281': 'drizzle',
  '284': 'drizzle',
  '293': 'drizzle',
  '296': 'drizzle',
  '299': 'rainy',
  '302': 'rainy',
  '305': 'rainy',
  '308': 'rainy',
  '311': 'drizzle',
  '314': 'rainy',
  '317': 'snowy',
  '320': 'snowy',
  '323': 'snowy',
  '326': 'snowy',
  '329': 'snowy',
  '332': 'snowy',
  '335': 'snowy',
  '338': 'snowy',
  '350': 'rainy',
  '353': 'drizzle',
  '356': 'rainy',
  '359': 'rainy',
  '362': 'drizzle',
  '365': 'snowy',
  '368': 'snowy',
  '371': 'snowy',
  '374': 'rainy',
  '377': 'rainy',
  '386': 'thunderstorm',
  '389': 'thunderstorm',
  '392': 'thunderstorm',
  '395': 'snowy',
}

function parseTime12h(raw: string): { hours: number; minutes: number } {
  const trimmed = raw.trim()
  const isPM = /PM$/i.test(trimmed)
  const isAM = /AM$/i.test(trimmed)
  const numPart = trimmed.replace(/(AM|PM)\s*$/i, '').trim()
  const [h, m] = numPart.split(':').map(Number)
  let hours = h
  if (isPM && hours < 12) hours += 12
  if (isAM && hours === 12) hours = 0
  return { hours, minutes: m ?? 0 }
}

function isDayTime(astronomy: { sunrise: string; sunset: string }): boolean {
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const rise = parseTime12h(astronomy.sunrise)
  const set = parseTime12h(astronomy.sunset)
  const riseMinutes = rise.hours * 60 + rise.minutes
  const setMinutes = set.hours * 60 + set.minutes
  return currentMinutes >= riseMinutes && currentMinutes < setMinutes
}

function mapCondition(weatherCode: string, isDay: boolean): WeatherCondition {
  const mapped = codeMap[weatherCode]
  if (!mapped) return 'cloudy'
  if (mapped === 'sunny' && !isDay) return 'clear-night'
  return mapped
}

function mapOpenMeteoCondition(weatherCode: number, isDay: boolean): WeatherCondition {
  if (weatherCode === 0) {
    return isDay ? 'sunny' : 'clear-night'
  }

  if (weatherCode === 1) return 'partly-cloudy'
  if (weatherCode === 2) return 'cloudy'
  if (weatherCode === 3) return 'overcast'
  if ([45, 48].includes(weatherCode)) return 'foggy'
  if ([51, 53, 55, 56, 57].includes(weatherCode)) return 'drizzle'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(weatherCode)) return 'rainy'
  if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) return 'snowy'
  if ([95, 96, 99].includes(weatherCode)) return 'thunderstorm'
  return 'cloudy'
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeLocationToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,，、'"`~!@#$%^&*()_\-+=:;./\\|?！？]/g, '')
    .replace(/(特别行政区|自治区|省|市|县|区|州|盟|旗|都|道|府|県|郡)$/u, '')
}

function getNameMatchScore(query: string, ...labels: Array<string | null | undefined>): number {
  const normalizedQuery = normalizeLocationToken(query)

  if (!normalizedQuery) {
    return 0
  }

  for (const label of labels) {
    const normalizedLabel = normalizeLocationToken(label ?? '')

    if (!normalizedLabel) {
      continue
    }

    if (normalizedLabel === normalizedQuery) {
      return 120
    }

    if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) {
      return 70
    }
  }

  return 0
}

function getOpenMeteoFeatureScore(featureCode: string | null): number {
  if (!featureCode) {
    return 0
  }

  return OPEN_METEO_FEATURE_SCORES[featureCode] ?? 20
}

function getNominatimScopeScore(addresstype: string | null): number {
  if (!addresstype) {
    return 0
  }

  return NOMINATIM_SCOPE_SCORES[addresstype] ?? 20
}

function getPopulationScore(population: number | null): number {
  if (population === null) {
    return 0
  }

  return Math.min(30, population / 1_000_000)
}

function getImportanceScore(importance: number | null): number {
  if (importance === null) {
    return 0
  }

  return Math.min(30, importance * 20)
}

function buildLocationCandidateKey(candidate: Pick<LocationCandidate, 'city' | 'admin1' | 'country'>): string {
  const city = normalizeLocationToken(candidate.city)
  const admin1 = normalizeLocationToken(candidate.admin1)
  const country = normalizeLocationToken(candidate.country)

  return `${city}|${admin1}|${country}`
}

function mergeLocationCandidates(candidates: LocationCandidate[]): LocationCandidate[] {
  const deduped = new Map<string, LocationCandidate>()

  for (const candidate of candidates) {
    const key = buildLocationCandidateKey(candidate)
    const existing = deduped.get(key)

    if (!existing || candidate.score > existing.score) {
      deduped.set(key, candidate)
    }
  }

  return [...deduped.values()].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score
    }

    if (right.sourceQuality !== left.sourceQuality) {
      return right.sourceQuality - left.sourceQuality
    }

    return left.city.localeCompare(right.city)
  })
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Weather API returned ${response.status} from ${new URL(url).host}`)
  }

  return response.json()
}

function createWeatherData(
  condition: WeatherCondition,
  city: string,
  temperature: number,
  isDay: boolean,
): WeatherData {
  return {
    condition,
    city,
    temperature,
    isDay,
    fetchedAt: new Date().toISOString(),
  }
}

async function fetchWttrWeather(city?: string): Promise<WeatherData> {
  const url = city
    ? `https://wttr.in/${encodeURIComponent(city)}?format=j1`
    : 'https://wttr.in/?format=j1'

  const json = await fetchJson(url)
  if (!json || typeof json !== 'object') {
    throw new Error('wttr.in returned an empty response')
  }

  const body = json as WttrResponse
  const current = body.current_condition?.[0]
  const astronomy = body.weather?.[0]?.astronomy?.[0]
  const area = body.nearest_area?.[0]

  if (!current || !astronomy || !area) {
    throw new Error('Unexpected weather API response format')
  }

  const temperature = readNumber((current as Record<string, unknown>).temp_C)
  const weatherCode = readString((current as Record<string, unknown>).weatherCode)
  const cityName = readString(area.areaName?.[0]?.value) ?? city?.trim() ?? ''
  const sunrise = readString((astronomy as Record<string, unknown>).sunrise)
  const sunset = readString((astronomy as Record<string, unknown>).sunset)

  if (temperature === null || !weatherCode || !sunrise || !sunset) {
    throw new Error('Unexpected weather API response format')
  }

  const isDay = isDayTime({ sunrise, sunset })
  return createWeatherData(mapCondition(weatherCode, isDay), cityName, temperature, isDay)
}

async function fetchAutoLocation(): Promise<WeatherLocation> {
  const json = await fetchJson('https://freeipapi.com/api/json/')
  if (!json || typeof json !== 'object') {
    throw new Error('Automatic location lookup returned an empty response')
  }

  const body = json as Record<string, unknown>
  const latitude = readNumber(body.latitude)
  const longitude = readNumber(body.longitude)

  if (latitude === null || longitude === null) {
    throw new Error('Automatic location lookup did not include coordinates')
  }

  return {
    city: readString(body.cityName) ?? 'Current location',
    latitude,
    longitude,
  }
}

async function fetchOpenMeteoLocationCandidates(
  city: string,
  language: 'en' | 'zh',
): Promise<LocationCandidate[]> {
  const trimmedCity = city.trim()
  const params = new URLSearchParams({
    name: trimmedCity,
    count: String(OPEN_METEO_GEOCODE_LIMIT),
    language,
    format: 'json',
  })

  const json = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`)
  if (!json || typeof json !== 'object') {
    return []
  }

  const results = (json as Record<string, unknown>).results
  if (!Array.isArray(results)) {
    return []
  }

  return results
    .filter((result): result is Record<string, unknown> => result !== null && typeof result === 'object')
    .flatMap((result) => {
      const latitude = readNumber(result.latitude)
      const longitude = readNumber(result.longitude)

      if (latitude === null || longitude === null) {
        return []
      }

      const name = readString(result.name) ?? trimmedCity
      const country = readString(result.country) ?? ''
      const admin1 = readString(result.admin1) ?? ''
      const featureScore = getOpenMeteoFeatureScore(readString(result.feature_code))

      return [
        {
          city: name,
          country,
          admin1,
          latitude,
          longitude,
          sourceQuality: featureScore,
          score:
            getNameMatchScore(trimmedCity, name, admin1, country) +
            featureScore +
            getPopulationScore(readNumber(result.population)),
        },
      ]
    })
}

async function fetchNominatimLocationCandidates(city: string): Promise<LocationCandidate[]> {
  const trimmedCity = city.trim()
  const params = new URLSearchParams({
    q: trimmedCity,
    format: 'jsonv2',
    limit: String(NOMINATIM_LIMIT),
    addressdetails: '1',
  })

  const json = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`)
  if (!Array.isArray(json)) {
    return []
  }

  return json
    .filter((result): result is Record<string, unknown> => result !== null && typeof result === 'object')
    .flatMap((result) => {
      const latitude = readNumber(result.lat)
      const longitude = readNumber(result.lon)

      if (latitude === null || longitude === null) {
        return []
      }

      const address =
        result.address && typeof result.address === 'object'
          ? (result.address as Record<string, unknown>)
          : {}
      const name =
        readString(address.city) ??
        readString(address.town) ??
        readString(address.municipality) ??
        readString(result.name) ??
        trimmedCity
      const admin1 =
        readString(address.state) ??
        readString(address.province) ??
        readString(address.county) ??
        ''
      const country = readString(address.country) ?? ''
      const displayName = readString(result.display_name)
      const scopeScore = getNominatimScopeScore(readString(result.addresstype))

      return [
        {
          city: name,
          country,
          admin1,
          latitude,
          longitude,
          sourceQuality: scopeScore,
          score:
            getNameMatchScore(trimmedCity, name, displayName, admin1, country) +
            scopeScore +
            getImportanceScore(readNumber(result.importance)),
        },
      ]
    })
}

async function collectLocationCandidates(
  city: string,
  preferredLanguage: 'en' | 'zh',
): Promise<LocationCandidate[]> {
  const trimmedCity = city.trim()
  const openMeteoCandidates = await fetchOpenMeteoLocationCandidates(trimmedCity, preferredLanguage)
  const shouldUseSecondaryGeocoder =
    openMeteoCandidates.length === 0 ||
    openMeteoCandidates.every((candidate) => candidate.sourceQuality <= OPEN_METEO_LOW_CONFIDENCE_SCORE)

  let secondaryCandidates: LocationCandidate[] = []

  if (shouldUseSecondaryGeocoder) {
    try {
      secondaryCandidates = await fetchNominatimLocationCandidates(trimmedCity)
    } catch (error) {
      if (openMeteoCandidates.length === 0) {
        throw error
      }
    }
  }

  return mergeLocationCandidates([...openMeteoCandidates, ...secondaryCandidates])
}

async function fetchCityLocation(city: string): Promise<WeatherLocation> {
  const trimmedCity = city.trim()
  const preferredLanguage = /[^\x20-\x7e]/.test(trimmedCity) ? 'zh' : 'en'
  const candidates = await collectLocationCandidates(trimmedCity, preferredLanguage)
  const location = candidates[0]

  if (!location) {
    throw new Error(`Unable to resolve coordinates for ${trimmedCity}`)
  }

  return {
    city: location.city,
    latitude: location.latitude,
    longitude: location.longitude,
  }
}

async function fetchOpenMeteoWeather(location: WeatherLocation): Promise<WeatherData> {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'temperature_2m,weather_code,is_day',
    forecast_days: '1',
    timezone: 'auto',
  })

  const json = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`)
  if (!json || typeof json !== 'object') {
    throw new Error('Open-Meteo returned an empty response')
  }

  const current = (json as Record<string, unknown>).current
  if (!current || typeof current !== 'object') {
    throw new Error('Open-Meteo current weather is missing')
  }

  const body = current as Record<string, unknown>
  const temperature = readNumber(body.temperature_2m)
  const weatherCode = readNumber(body.weather_code)
  const isDay = body.is_day === 1 || body.is_day === true || body.is_day === '1'

  if (temperature === null || weatherCode === null || !('is_day' in body)) {
    throw new Error('Open-Meteo current weather is incomplete')
  }

  return createWeatherData(
    mapOpenMeteoCondition(weatherCode, isDay),
    location.city,
    temperature,
    isDay,
  )
}

async function fetchFallbackWeather(city?: string): Promise<WeatherData> {
  const location = city?.trim() ? await fetchCityLocation(city) : await fetchAutoLocation()
  return fetchOpenMeteoWeather(location)
}

export async function fetchWeather(city?: string): Promise<WeatherData> {
  const cacheKey = city?.trim().toLowerCase() || '__auto__'
  const cached = cache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.data

  let data: WeatherData

  try {
    data = await fetchWttrWeather(city)
  } catch (error) {
    try {
      data = await fetchFallbackWeather(city)
    } catch (fallbackError) {
      const primaryMessage = error instanceof Error ? error.message : String(error)
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      throw new Error(
        `Unable to fetch weather from wttr.in or the fallback provider (${primaryMessage}; ${fallbackMessage})`,
      )
    }
  }

  cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS })
  return data
}

export async function searchCities(query: string): Promise<CitySuggestion[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const candidates = await collectLocationCandidates(trimmed, 'zh')

  return candidates.slice(0, 5).map((candidate) => ({
    name: candidate.city,
    country: candidate.country,
    admin1: candidate.admin1,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
  }))
}
