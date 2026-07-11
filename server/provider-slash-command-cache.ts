type AsyncTtlCacheOptions = {
  ttlMs: number
  maxEntries?: number
  now?: () => number
}

type AsyncTtlCacheEntry<Value> = {
  expiresAt: number
  promise: Promise<Value>
}

export const createAsyncTtlCache = <Value>({
  ttlMs,
  maxEntries = 32,
  now = Date.now,
}: AsyncTtlCacheOptions) => {
  const entries = new Map<string, AsyncTtlCacheEntry<Value>>()

  const prune = (currentTime: number) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) {
        entries.delete(key)
      }
    }

    while (entries.size >= maxEntries) {
      const oldestKey = entries.keys().next().value
      if (typeof oldestKey !== 'string') {
        break
      }
      entries.delete(oldestKey)
    }
  }

  return {
    get(key: string, load: () => Promise<Value>): Promise<Value> {
      const currentTime = now()
      const cached = entries.get(key)
      if (cached && cached.expiresAt > currentTime) {
        return cached.promise
      }

      if (cached) {
        entries.delete(key)
      }
      prune(currentTime)

      const promise = Promise.resolve().then(load)
      entries.set(key, {
        expiresAt: currentTime + ttlMs,
        promise,
      })

      void promise.catch(() => {
        if (entries.get(key)?.promise === promise) {
          entries.delete(key)
        }
      })

      return promise
    },
  }
}
