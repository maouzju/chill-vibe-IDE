import type {
  CcSwitchImportProfile,
  Provider,
  ProviderProfile,
  ProviderProfileCollection,
} from './schema.js'

const trimText = (value: string) => value.trim()

const normalizeBaseUrl = (value: string) => trimText(value).replace(/\/+$/g, '')

const normalizeFingerprint = (name: string, apiKey: string, baseUrl: string) =>
  JSON.stringify({
    name: trimText(name).toLowerCase(),
    apiKey: trimText(apiKey),
    baseUrl: normalizeBaseUrl(baseUrl),
  })

const createImportedProfileId = (provider: Provider, sourceId: string) =>
  `cc-switch:${provider}:${sourceId.trim()}`

const hasUsableApiKey = (apiKey: string) => trimText(apiKey).length > 0

export const summarizeImportedProfiles = (profiles: readonly CcSwitchImportProfile[]) =>
  profiles.reduce(
    (summary, profile) => {
      summary[profile.provider] += 1
      return summary
    },
    { claude: 0, codex: 0 },
  )

export const mergeImportedProviderProfiles = (
  collection: ProviderProfileCollection,
  provider: Provider,
  importedProfiles: readonly CcSwitchImportProfile[],
) => {
  const nextProfiles = [...collection.profiles]
  const importedForProvider = importedProfiles.filter((profile) => profile.provider === provider)
  const byId = new Map(nextProfiles.map((profile) => [profile.id, profile]))
  const byFingerprint = new Map(
    nextProfiles.map((profile) => [
      normalizeFingerprint(profile.name, profile.apiKey, profile.baseUrl),
      profile,
    ]),
  )

  let added = 0
  let updated = 0
  let nextActiveProfileId = collection.activeProfileId

  for (const importedProfile of importedForProvider) {
    const importedId = createImportedProfileId(provider, importedProfile.sourceId)
    const normalizedProfile: ProviderProfile = {
      id: importedId,
      name: trimText(importedProfile.name) || `${provider === 'claude' ? 'Claude' : 'Codex'} ${nextProfiles.length + 1}`,
      apiKey: trimText(importedProfile.apiKey),
      baseUrl: normalizeBaseUrl(importedProfile.baseUrl),
    }

    const existing =
      byId.get(importedId) ??
      byFingerprint.get(
        normalizeFingerprint(
          normalizedProfile.name,
          normalizedProfile.apiKey,
          normalizedProfile.baseUrl,
        ),
      )

    if (existing) {
      const nextProfile = {
        ...existing,
        id: existing.id,
        name: normalizedProfile.name || existing.name,
        apiKey: normalizedProfile.apiKey || existing.apiKey,
        baseUrl: normalizedProfile.baseUrl || existing.baseUrl,
      }
      const index = nextProfiles.findIndex((profile) => profile.id === existing.id)

      if (index >= 0) {
        const changed =
          nextProfile.name !== existing.name ||
          nextProfile.apiKey !== existing.apiKey ||
          nextProfile.baseUrl !== existing.baseUrl

        if (changed) {
          nextProfiles[index] = nextProfile
          byId.set(nextProfile.id, nextProfile)
          byFingerprint.set(
            normalizeFingerprint(nextProfile.name, nextProfile.apiKey, nextProfile.baseUrl),
            nextProfile,
          )
          updated += 1
        }
      }

      if (importedProfile.active && hasUsableApiKey(nextProfile.apiKey)) {
        nextActiveProfileId = nextProfile.id
      }

      continue
    }

    nextProfiles.push(normalizedProfile)
    byId.set(normalizedProfile.id, normalizedProfile)
    byFingerprint.set(
      normalizeFingerprint(normalizedProfile.name, normalizedProfile.apiKey, normalizedProfile.baseUrl),
      normalizedProfile,
    )
    added += 1

    if (importedProfile.active && hasUsableApiKey(normalizedProfile.apiKey)) {
      nextActiveProfileId = normalizedProfile.id
    }
  }

  return {
    added,
    updated,
    collection: {
      activeProfileId: nextActiveProfileId,
      profiles: nextProfiles,
    },
  }
}
