import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { fetchWeather, searchCities } from '../server/weather/weather-service.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const jsonResponse = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    headers: {
      'Content-Type': 'application/json',
    },
    ...init,
  })

test('fetchWeather falls back to open-meteo when wttr.in returns null', async () => {
  const urls: string[] = []

  globalThis.fetch = (async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    urls.push(url)

    if (url === 'https://wttr.in/?format=j1') {
      return jsonResponse(null)
    }

    if (url === 'https://freeipapi.com/api/json/') {
      return jsonResponse({
        cityName: 'Osaka',
        latitude: 34.7062,
        longitude: 135.493,
      })
    }

    if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) {
      return jsonResponse({
        current: {
          temperature_2m: 17.4,
          weather_code: 0,
          is_day: 1,
        },
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as typeof fetch

  const weather = await fetchWeather()

  assert.equal(weather.condition, 'sunny')
  assert.equal(weather.city, 'Osaka')
  assert.equal(weather.temperature, 17.4)
  assert.equal(weather.isDay, true)
  assert.match(weather.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(urls, [
    'https://wttr.in/?format=j1',
    'https://freeipapi.com/api/json/',
    'https://api.open-meteo.com/v1/forecast?latitude=34.7062&longitude=135.493&current=temperature_2m%2Cweather_code%2Cis_day&forecast_days=1&timezone=auto',
  ])
})

test('fetchWeather resolves Chinese city names through the secondary geocoder when open-meteo returns low-quality matches', async () => {
  const urls: string[] = []

  globalThis.fetch = (async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    urls.push(url)

    if (url === 'https://wttr.in/%E5%8C%97%E4%BA%AC?format=j1') {
      return jsonResponse(null)
    }

    if (
      url ===
      'https://geocoding-api.open-meteo.com/v1/search?name=%E5%8C%97%E4%BA%AC&count=5&language=zh&format=json'
    ) {
      return jsonResponse({
        results: [
          {
            name: '\u5317\u4eac',
            country: '\u4e2d\u56fd',
            admin1: '\u91cd\u5e86\u5e02',
            latitude: 30.72608,
            longitude: 108.67483,
            feature_code: 'PPL',
          },
        ],
      })
    }

    if (
      url ===
      'https://nominatim.openstreetmap.org/search?q=%E5%8C%97%E4%BA%AC&format=jsonv2&limit=5&addressdetails=1'
    ) {
      return jsonResponse([
        {
          lat: '39.9057136',
          lon: '116.3912972',
          name: '\u5317\u4eac\u5e02',
          display_name: '\u5317\u4eac\u5e02, \u4e2d\u56fd',
          addresstype: 'city',
          place_rank: 8,
          importance: 0.79,
          address: {
            city: '\u5317\u4eac\u5e02',
            state: '\u5317\u4eac\u5e02',
            country: '\u4e2d\u56fd',
          },
        },
      ])
    }

    if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) {
      return jsonResponse({
        current: {
          temperature_2m: 20.5,
          weather_code: 0,
          is_day: 1,
        },
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as typeof fetch

  const weather = await fetchWeather('\u5317\u4eac')

  assert.equal(weather.condition, 'sunny')
  assert.equal(weather.city, '\u5317\u4eac\u5e02')
  assert.equal(weather.temperature, 20.5)
  assert.equal(weather.isDay, true)
  assert.deepEqual(urls, [
    'https://wttr.in/%E5%8C%97%E4%BA%AC?format=j1',
    'https://geocoding-api.open-meteo.com/v1/search?name=%E5%8C%97%E4%BA%AC&count=5&language=zh&format=json',
    'https://nominatim.openstreetmap.org/search?q=%E5%8C%97%E4%BA%AC&format=jsonv2&limit=5&addressdetails=1',
    'https://api.open-meteo.com/v1/forecast?latitude=39.9057136&longitude=116.3912972&current=temperature_2m%2Cweather_code%2Cis_day&forecast_days=1&timezone=auto',
  ])
})

test('fetchWeather keeps high-confidence open-meteo city matches even when the secondary geocoder is unavailable', async () => {
  const urls: string[] = []

  globalThis.fetch = (async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    urls.push(url)

    if (url === 'https://wttr.in/%E4%B8%8A%E6%B5%B7?format=j1') {
      return jsonResponse(null)
    }

    if (
      url ===
      'https://geocoding-api.open-meteo.com/v1/search?name=%E4%B8%8A%E6%B5%B7&count=5&language=zh&format=json'
    ) {
      return jsonResponse({
        results: [
          {
            name: '\u4e0a\u6d77',
            country: '\u4e2d\u56fd',
            admin1: '\u4e0a\u6d77\u5e02',
            latitude: 31.22222,
            longitude: 121.45806,
            feature_code: 'PPLA',
            population: 24874500,
          },
        ],
      })
    }

    if (url.startsWith('https://nominatim.openstreetmap.org/search?')) {
      throw new Error('The secondary geocoder should not run for a high-confidence match.')
    }

    if (url.startsWith('https://api.open-meteo.com/v1/forecast?')) {
      return jsonResponse({
        current: {
          temperature_2m: 18.1,
          weather_code: 1,
          is_day: 1,
        },
      })
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as typeof fetch

  const weather = await fetchWeather('\u4e0a\u6d77')

  assert.equal(weather.condition, 'partly-cloudy')
  assert.equal(weather.city, '\u4e0a\u6d77')
  assert.equal(weather.temperature, 18.1)
  assert.equal(weather.isDay, true)
  assert.deepEqual(urls, [
    'https://wttr.in/%E4%B8%8A%E6%B5%B7?format=j1',
    'https://geocoding-api.open-meteo.com/v1/search?name=%E4%B8%8A%E6%B5%B7&count=5&language=zh&format=json',
    'https://api.open-meteo.com/v1/forecast?latitude=31.22222&longitude=121.45806&current=temperature_2m%2Cweather_code%2Cis_day&forecast_days=1&timezone=auto',
  ])
})

test('searchCities prefers city-level matches from the secondary geocoder when open-meteo suggestions are low quality', async () => {
  globalThis.fetch = (async (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    if (
      url ===
      'https://geocoding-api.open-meteo.com/v1/search?name=%E5%8C%97%E4%BA%AC&count=5&language=zh&format=json'
    ) {
      return jsonResponse({
        results: [
          {
            name: '\u5317\u4eac',
            country: '\u4e2d\u56fd',
            admin1: '\u91cd\u5e86\u5e02',
            latitude: 30.72608,
            longitude: 108.67483,
            feature_code: 'PPL',
          },
          {
            name: '\u5317\u4eac',
            country: '\u4e2d\u56fd',
            admin1: '\u56db\u5ddd',
            latitude: 30.9699,
            longitude: 103.94,
            feature_code: 'PPL',
          },
        ],
      })
    }

    if (
      url ===
      'https://nominatim.openstreetmap.org/search?q=%E5%8C%97%E4%BA%AC&format=jsonv2&limit=5&addressdetails=1'
    ) {
      return jsonResponse([
        {
          lat: '39.9057136',
          lon: '116.3912972',
          name: '\u5317\u4eac\u5e02',
          display_name: '\u5317\u4eac\u5e02, \u4e2d\u56fd',
          addresstype: 'city',
          place_rank: 8,
          importance: 0.79,
          address: {
            city: '\u5317\u4eac\u5e02',
            state: '\u5317\u4eac\u5e02',
            country: '\u4e2d\u56fd',
          },
        },
      ])
    }

    throw new Error(`Unexpected fetch URL: ${url}`)
  }) as typeof fetch

  const results = await searchCities('\u5317\u4eac')

  assert.deepEqual(results[0], {
    name: '\u5317\u4eac\u5e02',
    country: '\u4e2d\u56fd',
    admin1: '\u5317\u4eac\u5e02',
    latitude: 39.9057136,
    longitude: 116.3912972,
  })
  assert.deepEqual(results[1], {
    name: '\u5317\u4eac',
    country: '\u4e2d\u56fd',
    admin1: '\u91cd\u5e86\u5e02',
    latitude: 30.72608,
    longitude: 108.67483,
  })
})
