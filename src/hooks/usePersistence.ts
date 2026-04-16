import { useCallback, useEffect, useRef } from 'react'
import type { AppState } from '../../shared/schema'
import { queueStateSave, saveState } from '../api'
import type { LoadStatus, SaveStatus } from '../app-helpers'
import {
  createQueuedStateSaveScheduler,
  getPersistenceVersion,
  shouldPauseQueuedStateSave,
} from './persistence-queue'

export function usePersistence(
  appState: AppState,
  appStateRef: React.RefObject<AppState>,
  loadStatus: LoadStatus,
  setSaveStatus: (status: SaveStatus) => void,
) {
  const lastSavedSnapshot = useRef('')
  const lastQueuedSnapshot = useRef('')
  const lastSavedState = useRef<AppState | null>(null)
  const lastQueuedState = useRef<AppState | null>(null)
  const queuedSaveSchedulerRef = useRef<ReturnType<typeof createQueuedStateSaveScheduler> | null>(null)

  if (queuedSaveSchedulerRef.current === null) {
    queuedSaveSchedulerRef.current = createQueuedStateSaveScheduler({
      delayMs: 300,
      queueStateSave: (state) => {
        queueStateSave(state)
        setSaveStatus('saved')
      },
    })
  }

  const persistState = useCallback(async (nextState: AppState) => {
    try {
      await saveState(nextState)
      const version = getPersistenceVersion(nextState)
      lastSavedSnapshot.current = version
      lastQueuedSnapshot.current = version
      lastSavedState.current = nextState
      lastQueuedState.current = nextState
      setSaveStatus('saved')
    } catch {
      setSaveStatus('error')
    }
  }, [setSaveStatus])

  const persistImmediately = useCallback(
    (nextState: AppState) => {
      queuedSaveSchedulerRef.current?.cancel()
      setSaveStatus('saving')
      void persistState(nextState)
    },
    [persistState, setSaveStatus],
  )

  const flushPendingState = useCallback(() => {
    if (loadStatus !== 'ready') {
      return
    }

    const nextState = appStateRef.current
    const version = getPersistenceVersion(nextState)
    const alreadySaved = version === lastSavedSnapshot.current && nextState === lastSavedState.current
    const alreadyQueued = version === lastQueuedSnapshot.current && nextState === lastQueuedState.current

    if (!alreadySaved && !alreadyQueued) {
      lastQueuedSnapshot.current = version
      lastQueuedState.current = nextState
      queuedSaveSchedulerRef.current?.schedule(nextState)
    }

    if (queuedSaveSchedulerRef.current?.hasPending()) {
      queuedSaveSchedulerRef.current.flush()
    }
  }, [appStateRef, loadStatus])

  useEffect(() => {
    if (loadStatus !== 'ready') {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingState()
      }
    }

    const handlePageHide = () => {
      flushPendingState()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)
    window.addEventListener('beforeunload', handlePageHide)
    window.addEventListener('chill-vibe:flush-state-before-quit', handlePageHide)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
      window.removeEventListener('beforeunload', handlePageHide)
      window.removeEventListener('chill-vibe:flush-state-before-quit', handlePageHide)
    }
  }, [flushPendingState, loadStatus])

  useEffect(() => {
    return () => {
      queuedSaveSchedulerRef.current?.cancel()
    }
  }, [])

  useEffect(() => {
    if (loadStatus !== 'ready') {
      return
    }

    if (shouldPauseQueuedStateSave(appState)) {
      queuedSaveSchedulerRef.current?.cancel()
      return
    }

    const version = getPersistenceVersion(appState)
    const alreadySaved = version === lastSavedSnapshot.current && appState === lastSavedState.current
    const alreadyQueued = version === lastQueuedSnapshot.current && appState === lastQueuedState.current

    if (alreadySaved || alreadyQueued) {
      return
    }

    setSaveStatus('saving')
    lastQueuedSnapshot.current = version
    lastQueuedState.current = appState
    queuedSaveSchedulerRef.current?.schedule(appState)
  }, [appState, loadStatus, setSaveStatus])

  return {
    persistImmediately,
    flushPendingState,
    lastSavedSnapshot,
    lastQueuedSnapshot,
    lastSavedState,
    lastQueuedState,
  }
}
