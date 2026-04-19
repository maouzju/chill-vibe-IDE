import { useCallback, useEffect, useRef, useState } from 'react'

import { getLocaleText } from '../../shared/i18n'
import type {
  AppLanguage,
  BrainstormAnswer,
  BrainstormState,
  ChatCard as ChatCardModel,
  ModelPromptRule,
} from '../../shared/schema'
import { buildSystemPromptForModel } from '../../shared/system-prompt'
import { flashWindowOnce, openChatStream, requestChat, stopChat, type ChatStreamSource } from '../api'
import {
  getBrainstormCardStatus,
  normalizeBrainstormAnswerCount,
  resolveBrainstormRequestTarget,
} from './brainstorm-card-utils'
import { SparklesIcon, TrashIcon } from './Icons'

type BrainstormCardProps = {
  card: ChatCardModel
  language: AppLanguage
  systemPrompt: string
  modelPromptRules?: ModelPromptRule[]
  crossProviderSkillReuseEnabled: boolean
  providerReady: boolean
  workspacePath: string
  requestModel: string
  onDraftChange: (draft: string) => void
  onChangeTitle: (title: string) => void
  onPatchCard: (patch: Partial<Pick<ChatCardModel, 'status' | 'brainstorm'>>) => void
}

type ActiveAnswerStream = {
  source: ChatStreamSource
  streamId: string
}

const createStreamingAnswer = (): BrainstormAnswer => ({
  id: crypto.randomUUID(),
  content: '',
  status: 'streaming',
  streamId: crypto.randomUUID(),
  error: '',
})

const upsertAnswer = (
  state: BrainstormState,
  answerId: string,
  updater: (answer: BrainstormAnswer) => BrainstormAnswer,
) => {
  let changed = false
  const answers = state.answers.map((answer) => {
    if (answer.id !== answerId) {
      return answer
    }

    changed = true
    return updater(answer)
  })

  return changed ? { ...state, answers } : state
}

export function BrainstormCard({
  card,
  language,
  systemPrompt,
  modelPromptRules = [],
  crossProviderSkillReuseEnabled,
  providerReady,
  workspacePath,
  requestModel,
  onDraftChange,
  onChangeTitle,
  onPatchCard,
}: BrainstormCardProps) {
  const text = getLocaleText(language)
  const [draftValue, setDraftValue] = useState(card.draft ?? '')
  const draftTimerRef = useRef<number | null>(null)
  const activeStreamsRef = useRef(new Map<string, ActiveAnswerStream>())
  const latestCardRef = useRef(card)
  const latestBrainstormRef = useRef(card.brainstorm)

  useEffect(() => {
    latestCardRef.current = card
    latestBrainstormRef.current = card.brainstorm
  }, [card])

  useEffect(() => {
    if (draftTimerRef.current === null) {
      setDraftValue(card.draft ?? '')
    }
  }, [card.draft])

  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current)
      }

      for (const stream of activeStreamsRef.current.values()) {
        stream.source.close()
      }
      activeStreamsRef.current.clear()
    },
    [],
  )

  const commitBrainstorm = useCallback((nextBrainstorm: BrainstormState) => {
    latestBrainstormRef.current = nextBrainstorm
    onPatchCard({
      brainstorm: nextBrainstorm,
      status: getBrainstormCardStatus(nextBrainstorm),
    })
  }, [onPatchCard])

  const updateBrainstorm = useCallback((updater: (state: BrainstormState) => BrainstormState) => {
    commitBrainstorm(updater(latestBrainstormRef.current))
  }, [commitBrainstorm])

  const closeAnswerStream = useCallback((answerId: string, stopRemote = false) => {
    const active = activeStreamsRef.current.get(answerId)
    if (!active) {
      return
    }

    active.source.close()
    activeStreamsRef.current.delete(answerId)

    if (stopRemote) {
      void stopChat(active.streamId).catch(() => undefined)
    }
  }, [])

  const attachAnswerStream = useCallback((answerId: string, streamId: string) => {
    const existing = activeStreamsRef.current.get(answerId)
    if (existing?.streamId === streamId) {
      return
    }

    if (existing) {
      existing.source.close()
      activeStreamsRef.current.delete(answerId)
    }

    const source = openChatStream(streamId, {
      onDelta: ({ content }) => {
        updateBrainstorm((state) =>
          upsertAnswer(state, answerId, (answer) => ({
            ...answer,
            content: `${answer.content}${content}`,
            status: 'streaming',
            error: '',
          })),
        )
      },
      onAssistantMessage: ({ content }) => {
        updateBrainstorm((state) =>
          upsertAnswer(state, answerId, (answer) => ({
            ...answer,
            content: content || answer.content,
            status: 'streaming',
            error: '',
          })),
        )
      },
      onDone: () => {
        closeAnswerStream(answerId, false)
        void flashWindowOnce().catch(() => undefined)
        updateBrainstorm((state) =>
          upsertAnswer(state, answerId, (answer) => ({
            ...answer,
            status: 'done',
            streamId: undefined,
            error: '',
          })),
        )
      },
      onError: ({ message }) => {
        closeAnswerStream(answerId, false)
        updateBrainstorm((state) =>
          upsertAnswer(state, answerId, (answer) => ({
            ...answer,
            status: 'error',
            streamId: undefined,
            error: message,
          })),
        )
      },
    })

    activeStreamsRef.current.set(answerId, {
      source,
      streamId,
    })
  }, [closeAnswerStream, updateBrainstorm])

  useEffect(() => {
    const activeAnswerIds = new Map(
      card.brainstorm.answers
        .filter((answer) => answer.status === 'streaming' && answer.streamId)
        .map((answer) => [answer.id, answer.streamId as string]),
    )

    for (const [answerId, active] of activeStreamsRef.current.entries()) {
      if (activeAnswerIds.get(answerId) !== active.streamId) {
        active.source.close()
        activeStreamsRef.current.delete(answerId)
      }
    }

    for (const answer of card.brainstorm.answers) {
      if (answer.status === 'streaming' && answer.streamId) {
        attachAnswerStream(answer.id, answer.streamId)
      }
    }
  }, [attachAnswerStream, card.brainstorm.answers])

  const launchAnswer = useCallback(async (brainstorm: BrainstormState, answerId: string) => {
    const answerIndex = brainstorm.answers.findIndex((answer) => answer.id === answerId)
    const answer = brainstorm.answers[answerIndex]

    if (!answer || !brainstorm.prompt.trim()) {
      return
    }

    const { provider, model } = resolveBrainstormRequestTarget(brainstorm, requestModel)
    const prompt = brainstorm.prompt.trim()

    try {
      const composedSystemPrompt = buildSystemPromptForModel(systemPrompt, model, modelPromptRules)
      const response = await requestChat({
        provider,
        workspacePath,
        model,
        reasoningEffort: latestCardRef.current.reasoningEffort,
        sandboxMode: 'read-only',
        thinkingEnabled: latestCardRef.current.thinkingEnabled !== false,
        planMode: false,
        language,
        systemPrompt: composedSystemPrompt,
        modelPromptRules,
        crossProviderSkillReuseEnabled,
        streamId: answer.streamId,
        prompt,
        attachments: [],
      })

      if (response.streamId !== answer.streamId) {
        updateBrainstorm((state) =>
          upsertAnswer(state, answerId, (entry) => ({
            ...entry,
            streamId: response.streamId,
          })),
        )
      }

      const liveAnswer = latestBrainstormRef.current.answers.find((entry) => entry.id === answerId)
      if (!liveAnswer || liveAnswer.streamId !== response.streamId) {
        await stopChat(response.streamId).catch(() => undefined)
        return
      }

      attachAnswerStream(answerId, response.streamId)
    } catch (error) {
      updateBrainstorm((state) =>
        upsertAnswer(state, answerId, (entry) => ({
          ...entry,
          status: 'error',
          streamId: undefined,
          error: error instanceof Error ? error.message : String(error),
        })),
      )
    }
  }, [
    attachAnswerStream,
    crossProviderSkillReuseEnabled,
    language,
    modelPromptRules,
    requestModel,
    systemPrompt,
    updateBrainstorm,
    workspacePath,
  ])

  const persistDraftNow = useCallback((value: string) => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    onDraftChange(value)
  }, [onDraftChange])

  const handleDraftChange = (value: string) => {
    setDraftValue(value)

    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
    }

    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null
      onDraftChange(value)
    }, 280)
  }

  const handleStart = () => {
    const topic = draftValue.trim()

    if (!topic || !workspacePath.trim() || !providerReady) {
      return
    }

    if (!latestCardRef.current.title.trim()) {
      onChangeTitle(text.brainstormTitle)
    }

    for (const answer of latestBrainstormRef.current.answers) {
      closeAnswerStream(answer.id, true)
    }

    persistDraftNow(topic)

    const answerCount = normalizeBrainstormAnswerCount(latestBrainstormRef.current.answerCount)
    const answers = Array.from({ length: answerCount }, () => createStreamingAnswer())
    const nextBrainstorm: BrainstormState = {
      prompt: topic,
      provider: latestBrainstormRef.current.provider,
      model: latestBrainstormRef.current.model,
      answerCount,
      answers,
      failedAnswers: [],
    }

    commitBrainstorm(nextBrainstorm)

    for (const answer of answers) {
      void launchAnswer(nextBrainstorm, answer.id)
    }
  }

  const handleDeleteAnswer = (answerId: string) => {
    const current = latestBrainstormRef.current
    const removed = current.answers.find((answer) => answer.id === answerId)

    if (!removed) {
      return
    }

    closeAnswerStream(answerId, true)

    const remainingAnswers = current.answers.filter((answer) => answer.id !== answerId)

    if (!current.prompt.trim()) {
      commitBrainstorm({
        ...current,
        answers: remainingAnswers,
      })
      return
    }

    const replacement = createStreamingAnswer()
    const nextBrainstorm: BrainstormState = {
      ...current,
      answers: [...remainingAnswers, replacement],
    }

    commitBrainstorm(nextBrainstorm)
    void launchAnswer(nextBrainstorm, replacement.id)
  }

  const handleDeleteAll = () => {
    const current = latestBrainstormRef.current

    for (const answer of current.answers) {
      closeAnswerStream(answer.id, true)
    }

    if (!current.prompt.trim()) {
      commitBrainstorm({
        ...current,
        answers: [],
      })
      return
    }

    const answers = Array.from({ length: current.answerCount }, () => createStreamingAnswer())
    const nextBrainstorm: BrainstormState = {
      ...current,
      answers,
    }

    commitBrainstorm(nextBrainstorm)

    for (const answer of answers) {
      void launchAnswer(nextBrainstorm, answer.id)
    }
  }

  const handleAnswerCountChange = (value: string) => {
    const nextAnswerCount = normalizeBrainstormAnswerCount(Number(value))
    const current = latestBrainstormRef.current

    if (nextAnswerCount === current.answerCount) {
      return
    }

    if (nextAnswerCount < current.answers.length) {
      const removedAnswers = current.answers.slice(nextAnswerCount)
      for (const answer of removedAnswers) {
        closeAnswerStream(answer.id, true)
      }

      commitBrainstorm({
        ...current,
        answerCount: nextAnswerCount,
        answers: current.answers.slice(0, nextAnswerCount),
      })
      return
    }

    if (current.prompt.trim() && nextAnswerCount > current.answers.length) {
      const additions = Array.from(
        { length: nextAnswerCount - current.answers.length },
        () => createStreamingAnswer(),
      )
      const nextBrainstorm: BrainstormState = {
        ...current,
        answerCount: nextAnswerCount,
        answers: [...current.answers, ...additions],
      }

      commitBrainstorm(nextBrainstorm)

      for (const answer of additions) {
        void launchAnswer(nextBrainstorm, answer.id)
      }
      return
    }

    commitBrainstorm({
      ...current,
      answerCount: nextAnswerCount,
    })
  }

  const activeAnswerCount = card.brainstorm.answers.filter(
    (answer) => answer.status === 'streaming',
  ).length
  const hasPrompt = Boolean(card.brainstorm.prompt.trim())
  const hasVisibleResults = card.brainstorm.answers.some(
    (answer) => answer.status === 'error' || Boolean(answer.content.trim()),
  )
  const startDisabled = !draftValue.trim() || !workspacePath.trim() || !providerReady
  const statusMessage = !workspacePath.trim()
    ? { tone: 'is-warning', text: text.placeholderSetWorkspace }
    : !providerReady
      ? { tone: 'is-warning', text: text.placeholderCliUnavailable }
      : activeAnswerCount > 0
        ? { tone: 'is-active', text: text.brainstormGenerating }
        : !hasVisibleResults
          ? { tone: 'is-muted', text: text.brainstormEmptyHint(card.brainstorm.answerCount) }
          : null

  return (
    <div className="brainstorm-card" data-brainstorm-card>
      <div className="brainstorm-shell">
        <div className="brainstorm-composer">
          <div className="brainstorm-input-shell">
            <textarea
              className="control brainstorm-textarea"
              value={draftValue}
              onChange={(event) => handleDraftChange(event.target.value)}
              placeholder={text.brainstormPlaceholder}
              rows={3}
            />
          </div>

          <div className="brainstorm-toolbar">
            <label className="brainstorm-count-field">
              <span>{text.brainstormAnswerCountLabel}</span>
              <input
                className="control brainstorm-count-input"
                type="number"
                min={1}
                max={12}
                value={card.brainstorm.answerCount}
                onChange={(event) => handleAnswerCountChange(event.target.value)}
              />
            </label>

            <div className="brainstorm-toolbar-actions">
              <button
                type="button"
                className="brainstorm-button is-primary"
                disabled={startDisabled}
                onClick={handleStart}
              >
                <SparklesIcon />
                <span>{text.brainstormStart}</span>
              </button>

              <button
                type="button"
                className="brainstorm-button"
                disabled={card.brainstorm.answers.length === 0}
                onClick={handleDeleteAll}
              >
                <TrashIcon />
                <span>{text.brainstormDeleteAll}</span>
              </button>
            </div>
          </div>

          {statusMessage ? (
            <div className="brainstorm-status-row">
              <span className={`brainstorm-status ${statusMessage.tone}`}>
                {statusMessage.text}
              </span>
            </div>
          ) : null}
        </div>

        <div className="brainstorm-answer-list">
          {Array.from({ length: card.brainstorm.answerCount }, (_, index) => {
            const answer = card.brainstorm.answers[index]
            const stateClass =
              answer?.status === 'streaming'
                ? ' is-brainstorm-streaming'
                : answer?.status === 'error'
                  ? ' is-brainstorm-error'
                  : ''
            const hasAnswerContent = Boolean(answer?.content.trim())
            const fallbackText = hasPrompt ? text.brainstormWaiting : text.brainstormIdleSlot

            return (
              <article
                key={answer?.id ?? `brainstorm-slot-${index}`}
                className={`brainstorm-answer-card${stateClass}${hasAnswerContent ? '' : ' is-placeholder'}`}
              >
                <div className="brainstorm-answer-header">
                  <span className="brainstorm-answer-title">
                    {text.brainstormIdeaLabel} {index + 1}
                  </span>

                  {answer ? (
                    <button
                      type="button"
                      className="brainstorm-answer-delete"
                      aria-label={text.brainstormDeleteAnswer}
                      title={text.brainstormDeleteAnswer}
                      onClick={() => handleDeleteAnswer(answer.id)}
                    >
                      <TrashIcon />
                    </button>
                  ) : null}
                </div>

                <div className={`brainstorm-answer-body${hasAnswerContent ? '' : ' is-placeholder'}`}>
                  {answer?.content.trim() ? answer.content : fallbackText}
                </div>

                {answer?.status === 'error' && answer.error ? (
                  <div className="brainstorm-answer-error">{answer.error}</div>
                ) : null}
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}
