import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, OnboardingStatus, SetupStatus } from '../../shared/schema'
import { fetchOnboardingStatus, fetchSetupStatus } from '../api'
import {
  type OnboardingImportState,
  type OnboardingStage,
  errorMessage,
  getRoutingImportText,
  isFirstOpenState,
  onboardingStorageKey,
} from '../app-helpers'
import { getOnboardingText } from '../app-panel-text'
import type { IdeAction } from '../state'

export interface UseOnboardingDeps {
  appState: AppState
  loadStatus: 'loading' | 'ready' | 'error'
  setupStatus: SetupStatus | null
  setupStatusPending: boolean
  setSetupStatus: (status: SetupStatus | null) => void
  setSetupStatusPending: (pending: boolean) => void
  panelText: { runSetup: string }
  handleRunSetup: () => Promise<void>
  runCcSwitchImport: (
    request: { mode: 'default' } | { mode: 'upload'; fileName: string; dataBase64: string },
    language?: AppState['settings']['language'],
  ) => Promise<{ summary: string }>
  dispatch: React.Dispatch<IdeAction>
  applyAction: (action: IdeAction) => AppState
  settingsOpen: boolean
  syncProviderStatuses: () => Promise<void>
  textUnexpectedError: string
}

export function useOnboarding(deps: UseOnboardingDeps) {
  const {
    appState,
    loadStatus,
    setupStatus,
    setupStatusPending,
    setSetupStatus,
    setSetupStatusPending,
    panelText,
    handleRunSetup,
    runCcSwitchImport,
    applyAction,
    settingsOpen,
    syncProviderStatuses,
    textUnexpectedError,
  } = deps

  // --- State ---
  const [onboardingCandidate, setOnboardingCandidate] = useState(false)
  const [onboardingInitialized, setOnboardingInitialized] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [onboardingLanguage, setOnboardingLanguage] = useState<AppState['settings']['language']>(
    appState.settings.language,
  )
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [onboardingStatusPending, setOnboardingStatusPending] = useState(false)
  const [onboardingSetupSkipped, setOnboardingSetupSkipped] = useState(false)
  const [onboardingImportState, setOnboardingImportState] = useState<OnboardingImportState>('idle')
  const [onboardingImportNotice, setOnboardingImportNotice] = useState<string | null>(null)
  const [onboardingImportError, setOnboardingImportError] = useState<string | null>(null)

  // --- Ref ---
  const onboardingAutoSetupStartedRef = useRef(false)

  // --- Derived text ---
  const onboardingText = useMemo(() => getOnboardingText(onboardingLanguage), [onboardingLanguage])

  // --- Callbacks ---
  const loadOnboarding = useCallback(async () => {
    setOnboardingStatusPending(true)
    try {
      const status = await fetchOnboardingStatus()
      setOnboardingStatus(status)
      return status
    } finally {
      setOnboardingStatusPending(false)
    }
  }, [])

  const setGuideLanguage = useCallback(
    (language: AppState['settings']['language']) => {
      setOnboardingLanguage(language)
    },
    [],
  )

  const completeOnboarding = useCallback(() => {
    try {
      window.localStorage.setItem(onboardingStorageKey, 'done')
    } catch {
      // Ignore local storage failures and still let the user continue.
    }

    applyAction({
      type: 'updateSettings',
      patch: { language: onboardingLanguage },
    })
    setOnboardingOpen(false)
    setOnboardingCandidate(false)
    setOnboardingInitialized(true)
    setOnboardingImportError(null)
  }, [applyAction, onboardingLanguage])

  const handleOnboardingImport = useCallback(async () => {
    setOnboardingImportError(null)

    try {
      const result = await runCcSwitchImport({ mode: 'default' }, onboardingLanguage)
      setOnboardingImportState('imported')
      setOnboardingImportNotice(result.summary)
    } catch (error) {
      setOnboardingImportError(errorMessage(error, getRoutingImportText(onboardingLanguage).importError))
    }
  }, [onboardingLanguage, runCcSwitchImport])

  /**
   * Reset all onboarding state. Called by hydrate and handleReset in App.
   */
  const resetOnboardingState = useCallback(
    (state: AppState, opts?: { clearCandidate?: boolean }) => {
      if (opts?.clearCandidate) {
        setOnboardingCandidate(false)
      } else {
        setOnboardingCandidate(isFirstOpenState(state))
      }
      setOnboardingInitialized(false)
      setOnboardingOpen(false)
      setOnboardingLanguage(state.settings.language)
      setOnboardingStatus(null)
      setOnboardingImportState('idle')
      setOnboardingImportNotice(null)
      setOnboardingImportError(null)
      setOnboardingSetupSkipped(false)
    },
    [],
  )

  // --- Derived / computed values ---
  const onboardingMissingTools = useMemo(
    () =>
      onboardingStatus?.environment.checks
        .filter((check) => !check.available)
        .map((check) => check.label)
        .join(', ') ?? '',
    [onboardingStatus],
  )
  const onboardingEnvironmentReady = Boolean(onboardingStatus?.environment.ready) || setupStatus?.state === 'success'
  const showSettingsSetupPanel = !onboardingStatusPending && !onboardingEnvironmentReady
  const onboardingStage: OnboardingStage =
    onboardingStatusPending || !onboardingStatus
      ? 'loading'
      : !onboardingEnvironmentReady && !onboardingSetupSkipped
        ? 'setup'
        : onboardingStatus.ccSwitch.available && onboardingImportState === 'idle'
          ? 'import'
          : 'complete'
  const onboardingSetupSummary = onboardingSetupSkipped
    ? onboardingText.setupSkipped
    : onboardingEnvironmentReady
      ? setupStatus?.state === 'success'
        ? setupStatus.message ?? onboardingText.environmentReady
        : onboardingText.environmentReady
      : setupStatus?.state === 'unsupported'
        ? setupStatus.message ?? onboardingText.setupUnsupported
        : setupStatus?.message
          ? setupStatus.message
          : onboardingMissingTools
            ? onboardingText.missingTools(onboardingMissingTools)
            : onboardingText.runningSetup
  const onboardingImportSummary =
    onboardingImportState === 'imported' && onboardingImportNotice
      ? onboardingImportNotice
      : onboardingImportState === 'skipped'
        ? onboardingText.importSkipped
        : onboardingStatus?.ccSwitch.available
          ? onboardingText.ccSwitchDetected(onboardingStatus.ccSwitch.source ?? '~/.cc-switch/cc-switch.db')
          : onboardingText.ccSwitchMissing
  const onboardingCurrentTitle =
    onboardingStage === 'loading'
      ? onboardingText.loadingTitle
      : onboardingStage === 'setup'
        ? onboardingText.setupStepTitle
        : onboardingStage === 'import'
          ? onboardingText.importStepTitle
          : onboardingText.completeTitle
  const onboardingCurrentDescription =
    onboardingStage === 'loading'
      ? onboardingText.loadingDescription
      : onboardingStage === 'setup'
        ? setupStatus?.state === 'error' || setupStatus?.state === 'unsupported'
          ? setupStatus?.message ?? onboardingText.setupUnsupported
          : onboardingMissingTools
            ? onboardingText.missingTools(onboardingMissingTools)
            : onboardingText.runningSetup
        : onboardingStage === 'import'
          ? onboardingText.importPrompt(onboardingStatus?.ccSwitch.source ?? '~/.cc-switch/cc-switch.db')
          : onboardingText.completeDescription
  const onboardingSetupButtonLabel =
    setupStatusPending || setupStatus?.state === 'running'
      ? onboardingText.installing
      : setupStatus?.state === 'error' || setupStatus?.state === 'unsupported'
        ? onboardingText.retrySetup
        : panelText.runSetup

  // --- Effects ---

  // First-launch detection
  useEffect(() => {
    if (!onboardingCandidate || onboardingInitialized || loadStatus !== 'ready') {
      return
    }

    try {
      if (window.localStorage.getItem(onboardingStorageKey) === 'done') {
        setOnboardingInitialized(true)
        return
      }
    } catch {
      // Ignore local storage read failures and keep the guide available.
    }

    let cancelled = false

    const prepare = async () => {
      setOnboardingStatusPending(true)

      try {
        const [nextStatus, nextSetupStatus] = await Promise.all([fetchOnboardingStatus(), fetchSetupStatus()])

        if (cancelled) {
          return
        }

        setOnboardingStatus(nextStatus)
        setSetupStatus(nextSetupStatus)
        setOnboardingOpen(true)
      } catch {
        if (!cancelled) {
          setOnboardingCandidate(false)
          setOnboardingOpen(false)
        }
      } finally {
        if (!cancelled) {
          setOnboardingStatusPending(false)
          setOnboardingInitialized(true)
        }
      }
    }

    void prepare()

    return () => {
      cancelled = true
    }
  }, [loadStatus, onboardingCandidate, onboardingInitialized, setSetupStatus])

  // Sync setup status when onboarding or settings panel is open
  useEffect(() => {
    if (
      !settingsOpen &&
      !(
        onboardingOpen &&
        !(Boolean(onboardingStatus?.environment.ready) || setupStatus?.state === 'success') &&
        !onboardingSetupSkipped
      )
    ) {
      return
    }

    let cancelled = false

    const sync = async () => {
      setSetupStatusPending(true)
      try {
        const nextStatus = await fetchSetupStatus()
        if (!cancelled) {
          setSetupStatus(nextStatus)
        }
      } catch (error) {
        if (!cancelled) {
          setSetupStatus({
            state: 'error',
            message: errorMessage(error, textUnexpectedError),
            logs: [],
          })
        }
      } finally {
        if (!cancelled) {
          setSetupStatusPending(false)
        }
      }
    }

    void sync()

    if (setupStatus?.state !== 'running') {
      return () => {
        cancelled = true
      }
    }

    const timer = window.setInterval(() => {
      void sync()
    }, 1500)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [onboardingOpen, onboardingSetupSkipped, onboardingStatus?.environment.ready, settingsOpen, setupStatus?.state, textUnexpectedError, setSetupStatus, setSetupStatusPending])

  // Load onboarding when settings open
  useEffect(() => {
    if (!settingsOpen) {
      return
    }

    void loadOnboarding().catch(() => undefined)
  }, [loadOnboarding, settingsOpen])

  // Reload onboarding status after setup success
  useEffect(() => {
    if (setupStatus?.state === 'success') {
      void syncProviderStatuses()
      void loadOnboarding().catch(() => undefined)
    }
  }, [loadOnboarding, setupStatus?.state, syncProviderStatuses])

  // Auto-trigger setup in onboarding
  useEffect(() => {
    if (!onboardingOpen || onboardingStage !== 'setup') {
      onboardingAutoSetupStartedRef.current = false
      return
    }

    if (
      onboardingEnvironmentReady ||
      onboardingSetupSkipped ||
      setupStatusPending ||
      setupStatus?.state === 'running' ||
      setupStatus?.state === 'error' ||
      setupStatus?.state === 'unsupported'
    ) {
      return
    }

    if (onboardingAutoSetupStartedRef.current) {
      return
    }

    onboardingAutoSetupStartedRef.current = true
    void handleRunSetup()
  }, [
    handleRunSetup,
    onboardingEnvironmentReady,
    onboardingOpen,
    onboardingSetupSkipped,
    onboardingStage,
    setupStatus?.state,
    setupStatusPending,
  ])

  return {
    // State values
    onboardingOpen,
    onboardingLanguage,
    onboardingStatus,
    onboardingStatusPending,
    onboardingSetupSkipped,
    onboardingImportState,
    onboardingImportError,

    // Text
    onboardingText,

    // Derived values
    onboardingMissingTools,
    onboardingEnvironmentReady,
    onboardingStage,
    onboardingSetupSummary,
    onboardingImportSummary,
    onboardingCurrentTitle,
    onboardingCurrentDescription,
    onboardingSetupButtonLabel,
    showSettingsSetupPanel,

    // Setters (for JSX event handlers)
    setOnboardingSetupSkipped,
    setOnboardingImportState,
    setOnboardingImportError,

    // Callbacks
    loadOnboarding,
    setGuideLanguage,
    completeOnboarding,
    handleOnboardingImport,

    // For hydrate/handleReset
    resetOnboardingState,
  }
}
