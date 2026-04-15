import type { AppState, AppStateLoadResponse, AppStateRecovery, ProviderStatus } from '../shared/schema'

type StartInitialAppLoadOptions = {
  fetchState: () => Promise<AppStateLoadResponse>
  fetchProviders: () => Promise<ProviderStatus[]>
}

type InitialAppLoad = {
  state: AppState
  recovery: AppStateRecovery
  providersPromise: Promise<ProviderStatus[] | null>
}

export const startInitialAppLoad = async ({
  fetchState,
  fetchProviders,
}: StartInitialAppLoadOptions): Promise<InitialAppLoad> => {
  const providersPromise = fetchProviders().catch(() => null)
  const response = await fetchState()

  return {
    state: response.state,
    recovery: response.recovery,
    providersPromise,
  }
}
