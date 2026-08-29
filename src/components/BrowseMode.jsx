import { useCallback, useEffect, useRef, useState } from 'react'
import SavedCardsDrawer from './SavedCardsDrawer.jsx'
import {
  CARD_TYPES,
  createCard,
  deleteSavedCard,
  getCardExplanation,
  getCardMeeting,
  markCardMeetingRevealed,
  normalizeCard,
  normalizeCardHead,
  saveCard,
  streamEmptyCard,
} from '../services/cards.js'
import {
  CARD_DISPLAY_NAMES,
  CARD_ENGINE_NOTES,
  CARD_TYPE_SEQUENCE,
  CARD_ENTRY_DURATION,
  CARD_EXIT_DURATION,
  AVOID_EXIT_DURATION,
  FIRST_LOADING_CYCLE,
  FLOW_BUSY_STAGES,
  LOADER_FADE_DURATION,
  PULSE_MEETING_CARD_TYPES,
  SUGGESTED_TOPICS,
  SURFACE_CARD_TYPES,
} from './browseMode/constants.js'
import { shuffle, wait } from './browseMode/utils.js'
import { LoadingScene, SearchGlyphBuffer } from './browseMode/LoadingScenes.jsx'
import { CardScene } from './browseMode/CardViews.jsx'
import { useCandidateHighlights } from '../hooks/useCandidateHighlights.js'

function BrowseMode({
  seed,
  mode = 'explore',
  openingType: openingCardType = CARD_TYPES.SAND_SEA,
  savedCardRequest = null,
  onModeChange,
  onOpenSavedCard,
  onSearchInputChange,
  onSearchTypeChange,
  onReturn,
  candidatePool = null,
}) {
  const seedRef = useRef(normalizeCardHead(seed))
  const [searchInput, setSearchInput] = useState(() => normalizeCardHead(seed))
  const [showBrowseEngineMenu, setShowBrowseEngineMenu] = useState(false)
  const [browseCandidates, setBrowseCandidates] = useState([])
  const [staySeed, setStaySeed] = useState(() => normalizeCardHead(seed))
  const [showBrowseSuggestions, setShowBrowseSuggestions] = useState(false)
  const [browseSearchHint, setBrowseSearchHint] = useState('')

  useEffect(() => {
    if (mode !== 'new') return undefined
    const pool = candidatePool?.length ? candidatePool : SUGGESTED_TOPICS
    setBrowseCandidates(shuffle(pool).slice(0, 7))
    return undefined
  }, [mode, candidatePool])
  const browseSearchFormRef = useRef(null)
  const searchTransitionRef = useRef(false)
  const [searchTransition, setSearchTransition] = useState(false)
  const [searchTransitionKey, setSearchTransitionKey] = useState(0)
  const [stage, setStage] = useState('loading')
  const [awaitingInitialType, setAwaitingInitialType] = useState(false)
  const [cardType, setCardType] = useState(openingCardType)
  const [loadingType, setLoadingType] = useState(openingCardType)
  const [card, setCard] = useState(null)
  const [index, setIndex] = useState(0)
  const [saved, setSaved] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [showingRelation, setShowingRelation] = useState(false)
  const [explanationStatus, setExplanationStatus] = useState('idle')
  const [explanationError, setExplanationError] = useState(null)
  const [error, setError] = useState(null)
  const [exitMode, setExitMode] = useState(null)
  const [exitVector, setExitVector] = useState(null)
  const currentCardRef = useRef(null)
  const flowTokenRef = useRef(0)
  const cardRequestControllerRef = useRef(null)
  const explanationControllerRef = useRef(null)
  const actionLockedRef = useRef(false)
  const cardTypeOrderRef = useRef([])
  const lastRequestedTypeRef = useRef(null)
  const openingTypeRef = useRef(null)
  const cardTypeRequestRef = useRef(false)
  const entryTimerRef = useRef(null)
  const entryFrameRef = useRef(null)
  const cardSnapshotsRef = useRef(new Map())
  const emptyTasksRef = useRef(new Map())
  const savedCardsRef = useRef(new Set())
  const savedCardsDrawerRef = useRef(null)
  const savedCardRequestRef = useRef(savedCardRequest)
  const lastSavedCardTokenRef = useRef(null)
  const MAX_HEAD_LENGTH = 28
  const truncateHead = useCallback((value) => Array.from(String(value ?? '')).slice(0, MAX_HEAD_LENGTH).join(''), [])
  const browseInputLength = Array.from(searchInput).length
  const isBrowseOverLimit = browseInputLength > MAX_HEAD_LENGTH
  const browseHighlights = useCandidateHighlights(browseCandidates, browseInputLength)

  useEffect(() => {
    savedCardRequestRef.current = savedCardRequest
  }, [savedCardRequest])

  useEffect(() => {
    seedRef.current = seed
    setSearchInput(seed)
  }, [seed])

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (!browseSearchFormRef.current?.contains(event.target)) {
        setShowBrowseSuggestions(false)
        setShowBrowseEngineMenu(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [])

  const persistCardSnapshot = useCallback((nextCard, overrides = {}) => {
    if (!nextCard) return
    const previous = cardSnapshotsRef.current.get(nextCard.type)
    const hasSavedOverride = Object.prototype.hasOwnProperty.call(overrides, 'saved')
    const hasFeedbackOverride = Object.prototype.hasOwnProperty.call(overrides, 'feedback')
    const ordinal = Number(nextCard.ordinal)
    const fallbackIndex = Number.isFinite(ordinal) ? Math.max(0, ordinal - 1) : 0
    cardSnapshotsRef.current.set(nextCard.type, {
      card: nextCard,
      index: overrides.index ?? previous?.index ?? fallbackIndex,
      saved: hasSavedOverride ? overrides.saved : previous?.saved ?? false,
      feedback: hasFeedbackOverride ? overrides.feedback : previous?.feedback ?? null,
    })
  }, [])

  const updateEmptyCard = useCallback((cardId, patch) => {
    const task = emptyTasksRef.current.get(cardId)
    if (task) task.card = { ...task.card, ...patch, content: { ...(task.card.content || {}), ...(patch.content || {}) } }
    setCard((current) => current?.id === cardId ? { ...current, ...patch, content: { ...(current.content || {}), ...(patch.content || {}) } } : current)
    if (task?.card) persistCardSnapshot(task.card, {})
    if (task?.card && savedCardsRef.current.has(cardId)) saveCard(task.card).catch(() => {})
  }, [persistCardSnapshot])

  const discardEmptyTask = useCallback((cardId) => {
    const task = emptyTasksRef.current.get(cardId)
    if (task) {
      window.clearTimeout(task.retryTimer)
      task.retryTimer = null
      task.controller?.abort()
    }
    emptyTasksRef.current.delete(cardId)
  }, [])

  const pumpEmptyTask = useCallback(async (cardId, { force = false } = {}) => {
    const task = emptyTasksRef.current.get(cardId)
    if (!task || task.inFlight || (task.awaitingReveal && !force) || task.failed || !task.visible || (!force && task.finished)) return
    task.inFlight = true
    task.forceContinue = force
    if (force) task.finished = false
    task.pendingStream = ''
    task.card = {
      ...task.card,
      content: {
        ...(task.card.content || {}),
        stream_status: 'streaming',
        streamStatus: 'streaming',
      },
    }
    updateEmptyCard(cardId, { content: task.card.content })
    const controller = new AbortController()
    task.controller = controller
    try {
      await streamEmptyCard({
        cardId,
        seed: truncateHead(task.card.tail || task.card.input),
        single: true,
        force,
        signal: controller.signal,
        onEvent: (event, payload) => {
          if (event === 'delta' && payload?.delta) {
            task.pendingStream += payload.delta
          }
          if (event === 'sentence' && payload?.sentence) {
            const sentence = normalizeCardHead(payload.sentence)
            if (!sentence) return
            const nextStream = `${task.card.content?.stream || ''}${sentence}`
            const shouldReveal = task.visible
            task.awaitingReveal = shouldReveal
            task.failed = false
            task.card = {
              ...task.card,
              tail: sentence,
              content: {
                ...(task.card.content || {}),
                stream: nextStream,
                lines: [...(task.card.content?.lines || []), sentence],
                stream_status: shouldReveal ? 'revealing' : 'waiting',
                streamStatus: shouldReveal ? 'revealing' : 'waiting',
              },
            }
            updateEmptyCard(cardId, { content: task.card.content })
          }
          if (event === 'done') {
            const tail = normalizeCardHead(payload?.tail || task.card.tail)
            const shouldReveal = task.awaitingReveal
            const atLimit = payload?.atLimit === true
            if (shouldReveal) {
              updateEmptyCard(cardId, { tail, content: { ...(task.card.content || {}), stream_status: 'revealing', streamStatus: 'revealing', atLimit } })
              if (!force) task.finished = !payload?.paused
            } else {
              const nextStatus = force ? 'done' : (payload?.paused ? 'waiting' : 'done')
              updateEmptyCard(cardId, { tail, content: { ...(task.card.content || {}), stream_status: nextStatus, streamStatus: nextStatus, atLimit } })
              task.finished = nextStatus === 'done'
            }
          }
        },
      })
    } catch (error) {
      if (error?.name !== 'AbortError') {
        task.failed = !force
        const nextStatus = force ? 'done' : 'error'
        updateEmptyCard(cardId, { content: { stream_status: nextStatus, streamStatus: nextStatus } })
      }
    } finally {
      task.inFlight = false
      task.controller = null
      if (force) {
        task.forceContinue = false
        task.failed = false
        task.finished = true
        task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'done', streamStatus: 'done' } }
        updateEmptyCard(cardId, { content: task.card.content })
        return
      }
      if (task.awaitingReveal) return
      if (task.visible && !task.finished && !task.failed) {
        task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'waiting', streamStatus: 'waiting' } }
        updateEmptyCard(cardId, { content: task.card.content })
        task.retryTimer = window.setTimeout(() => {
          task.retryTimer = null
          pumpEmptyTask(cardId)
        }, 1000)
      }
    }
  }, [truncateHead, updateEmptyCard])

  const handleEmptyVisibility = useCallback((cardId, visible, visibleCard = null) => {
    const task = emptyTasksRef.current.get(cardId) || { card: visibleCard || currentCardRef.current, visible: false, inFlight: false, finished: false, awaitingReveal: false, forceContinue: false, failed: false, retryTimer: null }
    if (visibleCard) task.card = visibleCard
    if (!task.card || task.card.id !== cardId) return
    task.visible = visible
    if (!visible) {
      window.clearTimeout(task.retryTimer)
      task.retryTimer = null
      task.controller?.abort()
      if (task.forceContinue) {
        task.forceContinue = false
        task.finished = true
        task.awaitingReveal = false
        task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'done', streamStatus: 'done' } }
        updateEmptyCard(cardId, { content: task.card.content })
      } else if (task.awaitingReveal) {
        task.awaitingReveal = false
        const nextStatus = task.finished ? 'done' : 'waiting'
        task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: nextStatus, streamStatus: nextStatus } }
        updateEmptyCard(cardId, { content: task.card.content })
      }
    } else {
      if (task.failed) {
        // A user can explicitly revisit a failed stream to retry it; do not
        // silently spin requests while the card remains visible.
        task.failed = false
      }
    }
    emptyTasksRef.current.set(cardId, task)
    if (visible && !task.awaitingReveal) pumpEmptyTask(cardId)
  }, [pumpEmptyTask, updateEmptyCard])

  const handleEmptyRevealComplete = useCallback((cardId) => {
    const task = emptyTasksRef.current.get(cardId)
    if (!task) return
    task.awaitingReveal = false
    window.clearTimeout(task.retryTimer)
    task.retryTimer = null
    if (task.forceContinue) {
      task.forceContinue = false
      task.finished = true
      task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'done', streamStatus: 'done' } }
      updateEmptyCard(cardId, { content: task.card.content })
      return
    }
    if (task.visible && !task.finished) {
      // 初次生成一批后即停顿，把"继续续写"留给用户主动点击，不自动 fill 满。
      task.finished = true
      task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'done', streamStatus: 'done' } }
      updateEmptyCard(cardId, { content: task.card.content })
      task.forceContinue = false
    } else if (task.finished) {
      task.card = { ...task.card, content: { ...(task.card.content || {}), stream_status: 'done', streamStatus: 'done' } }
      updateEmptyCard(cardId, { content: task.card.content })
    }
  }, [pumpEmptyTask, updateEmptyCard])

  const handleEmptyContinue = useCallback((cardId) => {
    const task = emptyTasksRef.current.get(cardId)
    if (!task || task.inFlight) return
    pumpEmptyTask(cardId, { force: true })
  }, [pumpEmptyTask])

  useEffect(() => {
    currentCardRef.current = card
    if (card?.type !== CARD_TYPES.EMPTY) return
    const existing = emptyTasksRef.current.get(card.id)
    if (existing) existing.card = card
    else emptyTasksRef.current.set(card.id, { card, visible: false, inFlight: false, finished: card.content?.stream_status === 'done', awaitingReveal: false, forceContinue: false, failed: false, retryTimer: null })
  }, [card])

  const restoreCardSnapshot = useCallback((type) => {
    const snapshot = cardSnapshotsRef.current.get(type)
    if (!snapshot) return false
    // 缓存卡片跳过请求和加载器，但保留完整入场阶段；不守的 SVG
    // 边框正是从这个阶段的缩放状态开始放大的。
    flowTokenRef.current += 1
    cardRequestControllerRef.current?.abort()
    explanationControllerRef.current?.abort()
    window.clearTimeout(entryTimerRef.current)
    window.cancelAnimationFrame(entryFrameRef.current)
    setCard(snapshot.card)
    setCardType(type)
    setIndex(snapshot.index ?? Math.max(0, Number(snapshot.card.ordinal || 1) - 1))
    setSaved(Boolean(snapshot.saved))
    setFeedback(snapshot.feedback || null)
    setShowingRelation(false)
    setExplanationStatus(snapshot.card.explanation ? 'done' : 'idle')
    setExplanationError(null)
    setError(null)
    setExitMode(null)
    setExitVector(null)
    setStage('entering')
    actionLockedRef.current = true
    const entryToken = flowTokenRef.current
    // 等待一次绘制后再开始计时，避免 React 提交新卡片与入场动画
    // 的起点之间消耗掉极短的一段时间。
    entryFrameRef.current = window.requestAnimationFrame(() => {
      entryFrameRef.current = null
      entryTimerRef.current = window.setTimeout(() => {
        if (flowTokenRef.current !== entryToken) return
        actionLockedRef.current = false
        setStage('active')
        entryTimerRef.current = null
      }, CARD_ENTRY_DURATION)
    })
    return true
  }, [])

  const getNextCardType = useCallback(() => {
    if (cardTypeOrderRef.current.length === 0) {
      cardTypeOrderRef.current = shuffle(CARD_TYPE_SEQUENCE)

      if (
        cardTypeOrderRef.current.length > 1 &&
        cardTypeOrderRef.current[0] === lastRequestedTypeRef.current
      ) {
        ;[cardTypeOrderRef.current[0], cardTypeOrderRef.current[1]] = [
          cardTypeOrderRef.current[1],
          cardTypeOrderRef.current[0],
        ]
      }
    }

    const nextType = cardTypeOrderRef.current.shift()
    lastRequestedTypeRef.current = nextType
    return nextType
  }, [])

  const requestCard = useCallback(
    async ({ nextIndex, nextType, requestSeed, signal }) => {
      return createCard({
        head: requestSeed,
        type: nextType,
        index: nextIndex,
        signal,
      })
    },
    [],
  )

  const beginCardFlow = useCallback(
    async ({
      nextIndex,
      nextType,
      previousFeedback,
      requestSeed = seedRef.current,
      pendingRequest = null,
      requestController = null,
      loadingStartedAt = performance.now(),
    }) => {
      const token = flowTokenRef.current + 1
      flowTokenRef.current = token
      window.clearTimeout(entryTimerRef.current)
      window.cancelAnimationFrame(entryFrameRef.current)
      entryTimerRef.current = null
      explanationControllerRef.current?.abort()

      let controller = requestController
      let cardPromise = pendingRequest
      if (!cardPromise) {
        cardRequestControllerRef.current?.abort()
        controller = new AbortController()
        cardRequestControllerRef.current = controller
        cardPromise = requestCard({
          nextIndex,
          nextType,
          previousFeedback,
          requestSeed,
          signal: controller.signal,
        })
      }

      setIndex(nextIndex)
      setCardType(nextType)
      setLoadingType(nextType)
      setCard(null)
      setSaved(false)
      setFeedback(null)
      setShowingRelation(false)
      setExplanationStatus('idle')
      setExplanationError(null)
      setError(null)
      setExitMode(null)
      setExitVector(null)
      setStage('loading')
      actionLockedRef.current = false

      try {
        const nextCard = await cardPromise

        if (!nextCard) {
          throw new Error('服务端没有返回可展示的卡片。')
        }

        const elapsed = performance.now() - loadingStartedAt
        if (elapsed < FIRST_LOADING_CYCLE) {
          await wait(FIRST_LOADING_CYCLE - elapsed)
        }

        if (flowTokenRef.current !== token) return

        persistCardSnapshot(nextCard, {
          index: nextIndex,
          saved: false,
          feedback: null,
        })
        setCard(nextCard)
        setStage('loading-out')
        await wait(LOADER_FADE_DURATION)

        if (flowTokenRef.current !== token) return
        setStage('entering')
        await wait(CARD_ENTRY_DURATION)

        if (flowTokenRef.current !== token) return
        setStage('active')
        actionLockedRef.current = false
      } catch (requestError) {
        if (flowTokenRef.current !== token) return
        if (requestError.name === 'AbortError') return
        console.error(requestError)
        setError(requestError)
        setStage('error')
      } finally {
        if (cardRequestControllerRef.current === controller) {
          cardRequestControllerRef.current = null
        }
      }
    },
    [persistCardSnapshot, requestCard],
  )

  const beginPresetCardFlow = useCallback(
    async (rawCard, { fromCard = false } = {}) => {
      const token = flowTokenRef.current + 1
      flowTokenRef.current = token
      cardRequestControllerRef.current?.abort()
      explanationControllerRef.current?.abort()
      window.clearTimeout(entryTimerRef.current)
      window.cancelAnimationFrame(entryFrameRef.current)
      entryTimerRef.current = null
      entryFrameRef.current = null

      const currentCard = currentCardRef.current
      if (currentCard?.type === CARD_TYPES.EMPTY) discardEmptyTask(currentCard.id)

      if (fromCard) {
        actionLockedRef.current = true
        setExitMode('avoid')
        setExitVector(null)
        setStage('exiting')
        await wait(AVOID_EXIT_DURATION)
        if (flowTokenRef.current !== token) return
      }

      const presetCard = normalizeCard(rawCard, {
        head: rawCard?.head || rawCard?.input || '留印',
        type: rawCard?.type || CARD_TYPES.SAND_SEA,
        index: Math.max(0, Number(rawCard?.ordinal || 1) - 1),
      })

      setStaySeed(truncateHead(presetCard.head || presetCard.input))
      cardSnapshotsRef.current.clear()

      setIndex(Math.max(0, Number(presetCard.ordinal || 1) - 1))
      if (mode !== 'new') setCardType(presetCard.type)
      setLoadingType(presetCard.type)
      setCard(null)
      setSaved(true)
      savedCardsRef.current.add(presetCard.id)
      setFeedback(null)
      setShowingRelation(false)
      setExplanationStatus(presetCard.explanation ? 'done' : 'idle')
      setExplanationError(null)
      setError(null)
      setExitMode(null)
      setExitVector(null)
      setStage('loading')
      actionLockedRef.current = false

      await wait(FIRST_LOADING_CYCLE)
      if (flowTokenRef.current !== token) return

      persistCardSnapshot(presetCard, {
        index: Math.max(0, Number(presetCard.ordinal || 1) - 1),
        saved: true,
        feedback: null,
      })
      setCard(presetCard)
      setStage('loading-out')
      await wait(LOADER_FADE_DURATION)

      if (flowTokenRef.current !== token) return
      setStage('entering')
      await wait(CARD_ENTRY_DURATION)

      if (flowTokenRef.current !== token) return
      setStage('active')
      actionLockedRef.current = false
    },
    [discardEmptyTask, mode, persistCardSnapshot],
  )

  useEffect(() => {
    const openingType = openingTypeRef.current ?? openingCardType
    openingTypeRef.current = openingType

    if (savedCardRequestRef.current) return

    beginCardFlow({
      nextIndex: 0,
      nextType: openingType,
      previousFeedback: null,
    })

    return () => {
      flowTokenRef.current += 1
      cardRequestControllerRef.current?.abort()
      explanationControllerRef.current?.abort()
      window.clearTimeout(entryTimerRef.current)
      window.cancelAnimationFrame(entryFrameRef.current)
    }
  }, [beginCardFlow, getNextCardType])

  useEffect(() => {
    if (!savedCardRequest || savedCardRequest.token === lastSavedCardTokenRef.current) return
    lastSavedCardTokenRef.current = savedCardRequest.token
    const fromCard = Boolean(currentCardRef.current)
    beginPresetCardFlow(savedCardRequest.card, { fromCard })
  }, [beginPresetCardFlow, savedCardRequest])

  const selectCardType = useCallback((nextType) => {
    if (
      mode !== 'stay' ||
      searchTransitionRef.current ||
      cardTypeRequestRef.current ||
      actionLockedRef.current ||
      FLOW_BUSY_STAGES.has(stage)
    ) return
    if (nextType === cardType && card) return
    if (restoreCardSnapshot(nextType)) return
    setAwaitingInitialType(false)
    cardTypeRequestRef.current = true
    beginCardFlow({
      nextIndex: 0,
      nextType,
      previousFeedback: null,
      requestSeed: staySeed,
    }).finally(() => {
      cardTypeRequestRef.current = false
    })
  }, [beginCardFlow, card, cardType, mode, restoreCardSnapshot, stage, staySeed])

  const finishSearchTransition = useCallback(() => {
    if (!searchTransitionRef.current) return

    searchTransitionRef.current = false
    setSearchTransition(false)
    beginCardFlow({
      nextIndex: 0,
      nextType: cardType,
      previousFeedback: null,
    })
  }, [beginCardFlow, cardType])

  const handleSearchSubmit = useCallback(async (event) => {
    event.preventDefault()
    if (
      mode !== 'new' ||
      searchTransitionRef.current ||
      cardTypeRequestRef.current ||
      actionLockedRef.current ||
      FLOW_BUSY_STAGES.has(stage)
    ) return
    const overLimit = Array.from(searchInput).length > MAX_HEAD_LENGTH
    if (overLimit) {
      setShowBrowseSuggestions(false)
      setBrowseSearchHint('太多了，先控制在28字以内')
      return
    }
    const trimmed = searchInput.trim()
    if (!trimmed) return
    const nextSeed = truncateHead(trimmed)
    if (nextSeed === seedRef.current && mode !== 'new') return

    if (card?.type === CARD_TYPES.EMPTY) discardEmptyTask(card.id)
    cardRequestControllerRef.current?.abort()
    explanationControllerRef.current?.abort()

    const actionToken = flowTokenRef.current + 1
    flowTokenRef.current = actionToken

    // 已经有卡片时，先让当前卡片播放一次“避开”退出动画，再进入搜索过渡。
    if (card) {
      setExitMode('avoid')
      setExitVector(null)
      setStage('exiting')
      await wait(AVOID_EXIT_DURATION)
      if (flowTokenRef.current !== actionToken) return
    }

    seedRef.current = nextSeed
    setSearchInput(nextSeed)
    setShowBrowseSuggestions(false)
    cardSnapshotsRef.current.clear()
    cardTypeOrderRef.current = []
    lastRequestedTypeRef.current = null
    openingTypeRef.current = cardType
    cardTypeRequestRef.current = false
    setCard(null)
    setSaved(false)
    setFeedback(null)
    setShowingRelation(false)
    setExplanationStatus('idle')
    setExplanationError(null)
    setError(null)
    setExitMode(null)
    setExitVector(null)
    setStage('search-transition')
    searchTransitionRef.current = true
    setSearchTransitionKey((current) => current + 1)
    setSearchTransition(true)
  }, [card, cardType, discardEmptyTask, mode, searchInput, stage, truncateHead])

  const moveToNextCard = useCallback(
    async (
      nextFeedback,
      {
        continueLockedAction = false,
        preExitDelay = 0,
        nextExitMode = 'four',
        nextExitVector = null,
      } = {},
    ) => {
      if (
        (actionLockedRef.current && !continueLockedAction) ||
        stage !== 'active'
      )
        return
      actionLockedRef.current = true
      if (card?.type === CARD_TYPES.EMPTY) discardEmptyTask(card.id)
      if (mode !== 'stay') cardSnapshotsRef.current.clear()
      const actionToken = flowTokenRef.current
      const nextIndex = index + 1
      const nextType = mode === 'stay' ? cardType : getNextCardType()
      const requestSeed = mode === 'explore'
        ? (card?.tail || card?.content?.lines?.at(-1) || seedRef.current)
        : mode === 'stay' ? staySeed : searchInput
      const requestController = new AbortController()
      cardRequestControllerRef.current?.abort()
      cardRequestControllerRef.current = requestController
      explanationControllerRef.current?.abort()
      const loadingStartedAt = performance.now()
      const pendingRequest = requestCard({
        nextIndex,
        nextType,
        previousFeedback: nextFeedback,
        requestSeed,
        signal: requestController.signal,
      })
      pendingRequest.catch(() => {})

      if (preExitDelay > 0) await wait(preExitDelay)
      if (flowTokenRef.current !== actionToken) {
        requestController.abort()
        return
      }
      setExitMode(nextExitMode)
      setExitVector(nextExitVector)
      setStage('exiting')
      await wait(nextExitMode === 'avoid' ? AVOID_EXIT_DURATION : CARD_EXIT_DURATION)

      if (flowTokenRef.current !== actionToken) {
        requestController.abort()
        return
      }

      beginCardFlow({
        nextIndex,
        nextType,
        previousFeedback: nextFeedback,
        requestSeed,
        pendingRequest,
        requestController,
        loadingStartedAt,
      })
    },
    [beginCardFlow, card, cardType, discardEmptyTask, getNextCardType, index, mode, requestCard, saved, stage],
  )

  const handleSave = () => {
    if (actionLockedRef.current || stage !== 'active') return
    if (!card) return
    const next = !saved
    setSaved(next)
    if (next) {
      savedCardsRef.current.add(card.id)
      saveCard(card).catch(() => {})
    } else {
      savedCardsRef.current.delete(card.id)
      deleteSavedCard(card.id).catch(() => {})
    }
  }

  useEffect(() => {
    if (!card) return
    persistCardSnapshot(card, { index, saved, feedback })
  }, [card, feedback, index, persistCardSnapshot, saved])

  const handleMeetingReveal = useCallback((cardId) => {
    setCard((current) => current?.id === cardId ? { ...current, meetingRevealed: true } : current)
    markCardMeetingRevealed(cardId).catch(() => {})
  }, [])

  const handleToggleRelation = useCallback(() => {
    if (!card || actionLockedRef.current || stage !== 'active') return
    if (showingRelation) {
      setShowingRelation(false)
      return
    }

    setShowingRelation(true)
    if (SURFACE_CARD_TYPES.has(card.type)) {
      setExplanationStatus('done')
      setExplanationError(null)
      return
    }
    if (PULSE_MEETING_CARD_TYPES.has(card.type)) {
      if (card.explanation) {
        setExplanationStatus('done')
        setExplanationError(null)
        return
      }
      explanationControllerRef.current?.abort()
      const controller = new AbortController()
      explanationControllerRef.current = controller
      const cardId = card.id
      const token = flowTokenRef.current
      setExplanationStatus('loading')
      setExplanationError(null)

      getCardMeeting({
        cardId,
        card,
        signal: controller.signal,
      }).then((meeting) => {
        if (controller.signal.aborted || flowTokenRef.current !== token) return
        setCard((current) => current?.id === cardId ? { ...current, explanation: meeting } : current)
        setExplanationStatus('done')
      }).catch((requestError) => {
        if (requestError.name === 'AbortError') return
        console.error(requestError)
        if (flowTokenRef.current !== token) return
        setExplanationStatus('error')
        setExplanationError('这次相遇暂时还说不清楚。')
      }).finally(() => {
        if (explanationControllerRef.current === controller) {
          explanationControllerRef.current = null
        }
      })
      return
    }
    if (card.explanation) {
      setExplanationStatus('done')
      setExplanationError(null)
      return
    }

    explanationControllerRef.current?.abort()
    const controller = new AbortController()
    explanationControllerRef.current = controller
    const cardId = card.id
    const token = flowTokenRef.current
    setExplanationStatus('loading')
    setExplanationError(null)

    getCardExplanation({
      cardId,
      card,
      signal: controller.signal,
    }).then((explanation) => {
      if (controller.signal.aborted || flowTokenRef.current !== token) return
      setCard((current) => current?.id === cardId ? { ...current, explanation } : current)
      setExplanationStatus('done')
    }).catch((requestError) => {
      if (requestError.name === 'AbortError') return
      console.error(requestError)
      if (flowTokenRef.current !== token) return
      setExplanationStatus('error')
      setExplanationError('这条相遇暂时还说不清楚。')
    }).finally(() => {
      if (explanationControllerRef.current === controller) {
        explanationControllerRef.current = null
      }
    })
  }, [card, showingRelation, stage])

  const handleAvoid = () => {
    if (actionLockedRef.current || stage !== 'active') return
    moveToNextCard(advanceFeedback, { nextExitMode: 'avoid' })
  }

  const advanceFeedback = {
    action: saved ? 'save-and-next' : 'next',
    cardId: card?.id,
  }

  const handleSwipe = (gesture) => {
    if (mode !== 'explore') return
    moveToNextCard(advanceFeedback, {
      nextExitMode: gesture.mode,
      nextExitVector: gesture,
    })
  }

  const handleReturn = () => {
    flowTokenRef.current += 1
    if (card?.type === CARD_TYPES.EMPTY) discardEmptyTask(card.id)
    cardRequestControllerRef.current?.abort()
    explanationControllerRef.current?.abort()
    window.clearTimeout(entryTimerRef.current)
    window.cancelAnimationFrame(entryFrameRef.current)
    entryFrameRef.current = null
    entryTimerRef.current = null
    cardTypeRequestRef.current = false
    searchTransitionRef.current = false
    setSearchTransition(false)
    onReturn()
  }

  const handleModeChange = (nextMode) => {
    if (searchTransitionRef.current || actionLockedRef.current || nextMode === mode) return
    if (nextMode === 'stay' && card) setStaySeed(truncateHead(card.head || card.input || seedRef.current))
    setShowBrowseSuggestions(false)
    onModeChange?.(nextMode)
  }

  const handleNewBranch = useCallback((value) => {
    if (card?.type === CARD_TYPES.EMPTY) discardEmptyTask(card.id)
    const nextValue = truncateHead(value)
    setSearchInput(nextValue)
    onSearchInputChange?.(nextValue)
    onModeChange?.('new')
  }, [card, discardEmptyTask, onModeChange, onSearchInputChange, truncateHead])

  return (
    <>
    <div className={`browse browse--${mode} browse--${stage}`}>
      <header className="browse-topbar">
        <button type="button" onClick={() => savedCardsDrawerRef.current?.open()}>
          司空 <small>SIKONG</small>
        </button>
        <div className="browse-controls">
          <div className="browse-mode-switch" role="tablist" aria-label="切换阅读模式">
            <button type="button" role="tab" aria-selected={mode === 'new'} className={mode === 'new' ? 'is-active' : ''} onClick={() => handleModeChange('new')}>新枝</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'stay'}
              className={mode === 'stay' ? 'is-active' : ''}
              onClick={() => handleModeChange('stay')}
            >驻足</button>
            <button type="button" role="tab" aria-selected={mode === 'explore'} className={mode === 'explore' ? 'is-active' : ''} onClick={() => handleModeChange('explore')}>探索</button>
          </div>
          <form
            ref={browseSearchFormRef}
            className={`browse-search-form${mode === 'new' ? '' : ' browse-search-form--hidden'}`}
            onSubmit={handleSearchSubmit}
            aria-hidden={mode !== 'new'}
          >
              <div className="browse-engine-picker">
                <button type="button" className="browse-engine-select" onClick={() => { setShowBrowseSuggestions(false); setShowBrowseEngineMenu((value) => !value) }} aria-expanded={showBrowseEngineMenu}>{CARD_DISPLAY_NAMES[cardType]} <i>⌄</i></button>
                {showBrowseEngineMenu && <div className="browse-engine-menu">{CARD_TYPE_SEQUENCE.map((type) => <button type="button" key={type} className={cardType === type ? 'is-active' : ''} onClick={() => { setCardType(type); onSearchTypeChange?.(type); setShowBrowseEngineMenu(false) }}><strong>{CARD_DISPLAY_NAMES[type]}</strong><small>{CARD_ENGINE_NOTES[type]}</small></button>)}</div>}
              </div>
              <div className="browse-input-wrap">
                <input
                  type="text"
                  autoComplete="off"
                  value={searchInput}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setSearchInput(nextValue)
                    onSearchInputChange?.(nextValue)
                    setBrowseSearchHint('')
                    setShowBrowseSuggestions(Boolean(nextValue.trim()))
                  }}
                  onFocus={() => { setShowBrowseSuggestions(Boolean(searchInput.trim())); setShowBrowseEngineMenu(false); setBrowseSearchHint('') }}
                  aria-label="搜索新的起点"
                  placeholder="换一个起点"
                />
                <span className={`browse-input-count${isBrowseOverLimit ? ' is-over' : ''}`} aria-hidden="true">
                  {browseInputLength} / {MAX_HEAD_LENGTH}
                </span>
              </div>
              <button
                type="submit"
                disabled={!searchInput.trim() || FLOW_BUSY_STAGES.has(stage)}
              >
                由此生枝
              </button>
              {showBrowseSuggestions && searchInput.trim() && (
                <div className="browse-search-suggestions" role="listbox" aria-label="候选话题">
                  {browseCandidates.map((topic) => {
                    const marked = browseHighlights[topic] || []
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={topic === searchInput}
                        key={topic}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setSearchInput(topic)
                          onSearchInputChange?.(topic)
                          setBrowseSearchHint('')
                          setShowBrowseSuggestions(false)
                        }}
                      >
                        <span className="browse-candidate-text">
                          {Array.from(topic).map((char, index) => (
                            <span key={index} className={marked.includes(index) ? 'is-mark' : undefined}>{char}</span>
                          ))}
                        </span>
                        <i aria-hidden="true">↗</i>
                      </button>
                    )
                  })}
                </div>
              )}
              {browseSearchHint && (
                <div className="browse-search-hint" role="status">{browseSearchHint}</div>
              )}
          </form>
          {mode === 'stay' && card && (
            <nav className="card-type-selector" aria-label="选择卡片引擎">
              {CARD_TYPE_SEQUENCE.map((type) => (
                <button
                  type="button"
                  key={type}
                  className={[
                    cardType === type ? 'is-active' : '',
                    cardSnapshotsRef.current.has(type) ? 'is-visited' : '',
                  ].filter(Boolean).join(' ')}
                  aria-pressed={cardType === type}
                  disabled={
                    FLOW_BUSY_STAGES.has(stage) ||
                    cardTypeRequestRef.current ||
                    actionLockedRef.current
                  }
                  onClick={() => selectCardType(type)}
                >
                  {CARD_DISPLAY_NAMES[type]}
                </button>
              ))}
            </nav>
          )}
        </div>
      </header>

      {mode === 'stay' && <div className="stay-context">驻足于：{staySeed}<span /></div>}

      {searchTransition && (
        <SearchGlyphBuffer
          key={searchTransitionKey}
          onComplete={finishSearchTransition}
        />
      )}

      {(stage === 'loading' || stage === 'loading-out') && (
        <LoadingScene type={loadingType} leaving={stage === 'loading-out'} />
      )}

      {card &&
        stage !== 'loading' &&
        (stage !== 'loading-out' || card.type === CARD_TYPES.UNRULED) && (
        <CardScene
          card={card}
          mode={mode}
          stage={stage}
          saved={saved}
          feedback={feedback}
          exitMode={exitMode}
          exitVector={exitVector}
          showingRelation={showingRelation}
          explanationStatus={explanationStatus}
          explanationError={explanationError}
          meetingRevealed={Boolean(card.meetingRevealed)}
          onMeetingReveal={handleMeetingReveal}
          onToggleRelation={handleToggleRelation}
          onSave={handleSave}
          onAvoid={handleAvoid}
          onNext={() => moveToNextCard(advanceFeedback, { nextExitMode: 'four' })}
          onSwipe={handleSwipe}
          onEmptyVisibility={handleEmptyVisibility}
          onEmptyRevealComplete={handleEmptyRevealComplete}
          onEmptyContinue={handleEmptyContinue}
          onNewBranch={handleNewBranch}
        />
      )}

      {stage === 'error' && (
        <div className="browse-error" role="alert">
          <span>断</span>
          <p>{error?.message ?? '这条歧路暂时没有出现。'}</p>
          <button
            type="button"
            onClick={() =>
              beginCardFlow({
                nextIndex: index,
                nextType: cardType,
                previousFeedback: null,
              })
            }
          >
            再试一次
          </button>
        </div>
      )}

    </div>
    <SavedCardsDrawer
      ref={savedCardsDrawerRef}
      variant="embedded"
      onOpenCard={onOpenSavedCard}
      onReturnHome={handleReturn}
    />
    </>
  )
}

export default BrowseMode

