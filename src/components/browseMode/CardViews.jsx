import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CARD_TYPES } from '../../services/cards.js'
import {
  CARD_DISPLAY_NAMES,
  PULSE_MEETING_CARD_TYPES,
  SURFACE_CARD_TYPES,
  sandBorderParts,
  toneBorderParts,
} from './constants.js'
import { createExitFragments, shuffle } from './utils.js'

function UnruledEntrySvg() {
  const svgRef = useRef(null)

  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return

    const { width, height } = svg.getBoundingClientRect()
    if (!width || !height) return

    svg.style.setProperty(
      '--unruled-entry-scale-x',
      String(Math.min(1, 136 / width)),
    )
    svg.style.setProperty(
      '--unruled-entry-scale-y',
      String(Math.min(1, 88 / height)),
    )

    const browse = document.querySelector('.browse')
    const viewportCenter = browse
      ? browse.getBoundingClientRect().top + browse.getBoundingClientRect().height / 2
      : window.innerHeight / 2
    const loader = document.querySelector('.unruled-loader__cycle')
    if (loader) {
      const rect = loader.getBoundingClientRect()
      svg.style.setProperty(
        '--unruled-entry-offset-y',
        String(rect.top + rect.height / 2 - viewportCenter),
      )
    }
  }, [])

  return (
    <svg
      ref={svgRef}
      className="unruled-entry-svg"
      viewBox="0 0 1000 650"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g className="unruled-entry-svg__scale">
        <rect
          className="unruled-entry-svg__mouth"
          x="0"
          y="0"
          width="1000"
          height="650"
        />
      </g>
    </svg>
  )
}

function MouthBorder({ card, exitMode, exitFragments }) {
  const sandOrder = useMemo(
    () => shuffle([...Array(sandBorderParts.length).keys()]),
    [card.id],
  )

  const isSand = card.type === CARD_TYPES.SAND_SEA
  const isUnruled = card.type === CARD_TYPES.UNRULED
  const borderType = isSand ? 'sand' : card.type

  const renderParts = (withDecoration) => {
    if (!isSand) {
      const strokes = toneBorderParts.map((part, index) => (
        <i
          className={`mouth-stroke ${part}`}
          key={part}
          style={{ '--order': index }}
        />
      ))

      return (
        <>
          {isUnruled ? (
            <span className="unruled-mouth-shell">{strokes}</span>
          ) : strokes}
          {withDecoration && isUnruled && (
            <UnruledEntrySvg />
          )}
        </>
      )
    }

    return sandBorderParts.map((part, index) => (
      <i
        className={`mouth-part ${part}`}
        key={part}
        style={{ '--order': sandOrder[index] }}
      />
    ))
  }

  return (
    <>
      <div
        className={`mouth-border mouth-border--${borderType} ${exitFragments.length ? 'mouth-border--splitting' : ''}`}
        aria-hidden="true"
      >
        {renderParts(true)}
      </div>

      {exitFragments.length > 0 && (
        <div className="mouth-fracture" aria-hidden="true">
          {exitFragments.map((fragment, index) => (
            <div
              className={`mouth-fragment mouth-fragment--${exitMode}-${index + 1}`}
              key={`${exitMode}-${index}`}
              style={{
                '--fragment-x': `${fragment.x}px`,
                '--fragment-y': `${fragment.y}px`,
              }}
            >
              <div
                className={`mouth-border mouth-border--${borderType} mouth-border--exit-copy`}
              >
                {renderParts(false)}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function RelationPanel({ card, explanation, status, error, closing = false }) {
  const surfaceOnly = SURFACE_CARD_TYPES.has(card?.type)
  const specialMeeting = card?.type === CARD_TYPES.BLIND_POEM || card?.type === CARD_TYPES.BOOK_OF_ANSWERS

  function buildChain(c) {
    switch (c.type) {
      case CARD_TYPES.SAND_SEA:
        return [{ title: '偶遇', text: '祂只是拾起了一条新枝 “' + (c.tail || '') + '”' }]
      case CARD_TYPES.MAGIC_TONE: {
        const origin = c.originWord || c.head || ''
        const misheard = c.misheardWord || ''
        return [
          { title: '如是', text: '“' + c.head + '” 你这样说' },
          { title: '偶闻', text: '“' + origin + '” 一词传入了祂的耳中' },
          { title: '缪错', text: '可祂却将其听成了 “' + misheard + '”' },
          { title: '生题', text: '于是，祂向你抛出 “' + (c.tail || '') + '”' },
        ]
      }
      case CARD_TYPES.UNRULED: {
        const word = c.decomposedWord || c.head || ''
        const parts = Array.isArray(c.decomposedParts) ? c.decomposedParts : []
        const images = Array.isArray(c.decomposedImages) ? c.decomposedImages : []
        const partStr = parts.length > 0 ? parts.join('、') : ''
        const imageStr = images.length > 0 ? images.join('、') : ''
        return [
          { title: '如是', text: '“' + c.head + '” 你这样写' },
          { title: '一瞥', text: '“' + word + '” 一词进入了祂的视线' },
          { title: '解字', text: '文字学家将其拆解为 “'+ partStr + '”' },
          { title: '观象', text: '“' + imageStr + '” 祂想到了这些' },
          { title: '生题', text: '最终 一股念头从心中升起 “' + (c.tail || '') + '”' },
        ]
      }
      case CARD_TYPES.WORD_REVERSE: {
        const pairs = Array.isArray(c.oppositePairs) ? c.oppositePairs : []
        const pairStr = pairs.length > 0 ? pairs.map(p => p.source + '→' + p.opposite).join('、') : ''
        return [
          { title: '取反', text: pairStr || '逐词取反' },
          { title: '成句', text: '于是祂向你抛出了“' + (c.tail || '') + '”' },
        ]
      }
      case CARD_TYPES.BLIND_POEM: {
        const head = c.input || c.head
        const firstLine = c.content?.lines?.[0] || head
        const secondLine = c.content?.lines?.[1] || c.tail || firstLine
        return [
          { title: '诗化', text: '“' + head + '” 被赋予诗意 「' + firstLine + '」' },
          { title: '相遇', text: '而后 这句诗遇见了「' + secondLine + '」' },
        ]
      }
      case CARD_TYPES.BOOK_OF_ANSWERS: {
        const answer = c.content?.lines?.[0] || c.tail || '一页书纸'
        return [{ title: '相遇', text: '纸上写着 「' + answer + '」' }]
      }
      default:
        return []
    }
  }

  const chain = buildChain(card)
  const humanReading = explanation?.humanReading

  if (specialMeeting) {
    const isBlindPoem = card?.type === CARD_TYPES.BLIND_POEM
    const firstLine = card?.content?.lines?.[0] || ''
    const secondLine = card?.content?.lines?.[1] || ''
    const meetingTitle = explanation?.title || (isBlindPoem ? '两句诗偶然碰到了一起' : '一页书纸意外地飘到你的身前')
    const meetingExplanation = explanation?.explanation || (isBlindPoem
      ? '这两句像从不同方向吹来的风，在纸页上短暂地共用同一片空白。'
      : '这句书页上的话，像一枚从别处落下的路标，恰好照亮了你原本的起点。')
    return (
      <div className={`relation-panel relation-panel--meeting${closing ? ' relation-panel--closing' : ''}`} aria-live="polite">
        <p className="relation-panel__title">何以相遇</p>
        {status === 'loading' && (
          <p className="relation-panel__status">正在把这次相遇整理成一句解释……</p>
        )}
        {status === 'error' && (
          <p className="relation-panel__status">{error || '这次相遇暂时还没有解释。'}</p>
        )}
        {status !== 'loading' && status !== 'error' && (
          <div className="relation-panel__content">
            <section className="relation-panel__section">
              <h3 className="relation-panel__meeting-heading relation-panel__meeting-heading--ink">{card.typeNote || '相遇'}</h3>
              <ol>
                {chain.map((item, index) => (
                  <li key={`${item.title || '相遇'}-${item.text || index}-${index}`}>
                    {item.title && <strong>{item.title}</strong>}
                    <span>{item.text || item}</span>
                  </li>
                ))}
              </ol>
            </section>
            <div className="relation-panel__divider-spacer" aria-hidden="true" />
            {isBlindPoem ? (
              <>
                <div className="relation-panel__meeting-poem-lines">
                  <p>{firstLine} / {secondLine}</p>
                </div>
                <div className="relation-panel__meeting-gap" aria-hidden="true" />
              </>
            ) : (
              <>
                <p className="relation-panel__meeting-title-line">{meetingTitle}</p>
                <div className="relation-panel__meeting-gap" aria-hidden="true" />
              </>
            )}
            <p className="relation-panel__explanation">{meetingExplanation}</p>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`relation-panel${closing ? ' relation-panel--closing' : ''}`} aria-live="polite">
      <p className="relation-panel__title">何以相遇</p>
      {!surfaceOnly && status === 'loading' && (
        <p className="relation-panel__status">正在把真实发生的偏移整理成一条可读的路……</p>
      )}
      {!surfaceOnly && status === 'error' && (
        <p className="relation-panel__status">{error || '解释暂时没有抵达，请稍后再试。'}</p>
      )}
      <div className="relation-panel__content">
        {(surfaceOnly || status !== 'loading') && chain.length > 0 && (
          <section className="relation-panel__section">
            <h3 className="relation-panel__heading--ink">{card.typeNote || '生成过程'}</h3>
            <ol>
              {chain.map((item, index) => (
                <li key={`${item.title || '过程'}-${item.text || index}-${index}`}>
                  {item.title && <strong>{item.title}</strong>}
                  <span>{item.text || item.value || item}</span>
                </li>
              ))}
            </ol>
          </section>
        )}
        {!surfaceOnly && status !== 'loading' && humanReading && (
          <section className="relation-panel__section relation-panel__reading">
            <h3>直观理解</h3>
            {humanReading.title && <p>{humanReading.title}</p>}
            {humanReading.interpret && <p>{humanReading.interpret}</p>}
          </section>
        )}
      </div>
    </div>
  )
}

function EmptyCardCopy({ card, active, onVisibilityChange, onRevealComplete, onContinue }) {
  const seed = card.input || card.content?.seed || ''
  const lines = Array.isArray(card.content?.lines) ? card.content.lines : []
  const streamStatus = card.content?.stream_status || card.content?.streamStatus
  const isWaiting = ['pending', 'streaming'].includes(streamStatus)
  const isRevealing = active && streamStatus === 'revealing'
  const isFinished = streamStatus === 'done'
  const atLimit = card.content?.atLimit === true
  const revealDoneRef = useRef('')
  useEffect(() => {
    onVisibilityChange?.(card.id, active)
    return () => onVisibilityChange?.(card.id, false)
  }, [active, card.id, onVisibilityChange])

  const finishReveal = () => {
    const token = `${card.id}:${lines.length}:${active}`
    if (revealDoneRef.current === token) return
    revealDoneRef.current = token
    onRevealComplete?.(card.id)
  }

  return (
    <div className="empty-card-copy">
      <p className="empty-card-stream">
        <span className="empty-card-segment empty-card-seed-inline">{seed}</span>
        {lines.map((line, lineIndex) => {
          const isLast = lineIndex === lines.length - 1
          const characters = [...line]
          return (
            <span
              className={`empty-card-segment${isLast ? ` empty-card-segment--last${isRevealing ? ' is-revealing' : ''}` : ''}`}
              key={isLast ? `${card.id}:last:${lines.length}` : `${card.id}:${lineIndex}`}
            >
              {characters.map((char, charIndex) => (
                <span
                  className={isLast ? 'empty-card-last-char' : undefined}
                  key={`${charIndex}-${char}`}
                  style={isLast && isRevealing ? { animationDelay: `${charIndex * 34}ms` } : undefined}
                  onAnimationEnd={isLast && isRevealing && charIndex === characters.length - 1 ? finishReveal : undefined}
                >{char}</span>
              ))}
            </span>
          )
        })}
      </p>
      {isFinished && !atLimit && (
        <button className="empty-card-continue" type="button" onClick={() => onContinue?.(card.id)}>
          继续续写
        </button>
      )}
      {isFinished && atLimit && (
        <span className="empty-card-limit">
          续写已达到上限
        </span>
      )}
      {isWaiting && (
        <span className="empty-card-status">
          正在等下一句靠近
          <span className="empty-card-status-dots" aria-hidden="true">
            <span className="empty-card-status-dot" />
            <span className="empty-card-status-dot" />
            <span className="empty-card-status-dot" />
          </span>
        </span>
      )}
    </div>
  )
}

function SurfaceCardCopy({ card }) {
  const surface = card.surface || {}
  const tail = card.tail || card.input || '一条意外方向正在形成。'
  const reading = surface.tailReading || '它像一条临时出现的小路，先不必急着走通。'
  const meeting = surface.humanReading || {}
  const title = meeting.title || '一次意外的相遇'
  const interpret = meeting.interpret || '它们像在陌生路口擦肩，前一个名字把一小束光递给了后一个名字。'

  return (
    <div className="surface-card-copy">
      <p className="surface-card-copy__tail">{tail}</p>
      <p className="surface-card-copy__reading">{reading}</p>
      <div className="surface-card-copy__divider-spacer" aria-hidden="true" />
      <div className="surface-card-copy__meeting">
        <p className="surface-card-copy__meeting-title">{title}</p>
        <p>{interpret}</p>
      </div>
    </div>
  )
}

function CardCopy({ card, active, onEmptyVisibility, onEmptyRevealComplete, onEmptyContinue }) {
  if (SURFACE_CARD_TYPES.has(card.type)) return <SurfaceCardCopy card={card} />

  if (card.type === CARD_TYPES.BLIND_POEM) {
    return (
      <div className="blind-poem">
        <p>{card.content?.lines?.[0] || '这是一句很诗意的话'}</p>
        <i aria-hidden="true">/</i>
        <p>{card.content?.lines?.[1] || '这又是一句诗意的话'}</p>
      </div>
    )
  }

  if (card.type === CARD_TYPES.EMPTY) {
    return (
      <EmptyCardCopy
        card={card}
        active={active}
        onVisibilityChange={onEmptyVisibility}
        onRevealComplete={onEmptyRevealComplete}
        onContinue={onEmptyContinue}
      />
    )
  }

  return <h2 className="answer-placeholder">{card.content?.lines?.[0] || '这是一句很有答案的话'}</h2>
}

export function CardScene({
  card,
  mode = 'explore',
  stage,
  saved,
  feedback,
  exitMode,
  exitVector,
  showingRelation,
  explanationStatus,
  explanationError,
  meetingRevealed,
  onMeetingReveal,
  onToggleRelation,
  onSave,
  onAvoid,
  onNext,
  onSwipe,
  onEmptyVisibility,
  onEmptyRevealComplete,
  onEmptyContinue,
  onNewBranch,
}) {
  const gestureRef = useRef(null)
  const wasShowingRelationRef = useRef(showingRelation)
  const [relationLeaving, setRelationLeaving] = useState(false)
  const emptyStreamBusy = card.type === CARD_TYPES.EMPTY &&
    ['pending', 'streaming'].includes(card.content?.stream_status || card.content?.streamStatus)
  const hasSurfaceMeeting = SURFACE_CARD_TYPES.has(card.type)
  const hasPulseMeeting = PULSE_MEETING_CARD_TYPES.has(card.type)
  const hasNoMeetingButton = card.type === CARD_TYPES.EMPTY
  const actionsClassName = hasNoMeetingButton ? 'card-actions card-actions--empty' : 'card-actions'
  const relationVisible = showingRelation || relationLeaving || wasShowingRelationRef.current
  useEffect(() => {
    if (!showingRelation && wasShowingRelationRef.current) {
      wasShowingRelationRef.current = false
      setRelationLeaving(true)
      const timer = window.setTimeout(() => setRelationLeaving(false), 240)
      return () => window.clearTimeout(timer)
    }
    wasShowingRelationRef.current = showingRelation
    if (showingRelation) setRelationLeaving(false)
    return undefined
  }, [showingRelation])
  const exitFragments = useMemo(
    () => createExitFragments(exitMode, exitVector),
    [exitMode, exitVector],
  )
  const cardClassName = [
    'card-scene',
    `card-scene--${card.type}`,
    `card-scene--${stage}`,
    relationVisible ? 'card-scene--relation' : '',
    exitMode ? `card-scene--exit-${exitMode}` : '',
    saved ? 'card-scene--saved' : '',
    exitMode === 'avoid' ? 'card-scene--avoided' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const handlePointerDown = (event) => {
    if (stage !== 'active' || !event.isPrimary || mode !== 'explore' || emptyStreamBusy) return

    const target = event.target
    const interactive =
      target instanceof Element && target.closest('button, a, input, select, textarea')
    const selectable =
      target instanceof Element &&
      target.closest(
        '.card-content, .card-phonetics, .relation-panel, .browse-topbar, .save-stamp',
      )
    const selectionAtStart = window.getSelection?.()?.toString() ?? ''

    gestureRef.current = {
      pointerId: event.pointerId,
      ignored: Boolean(interactive || selectable),
      selectionAtStart,
      startX: event.clientX,
      startY: event.clientY,
    }

    if (!interactive) {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
  }

  const finishPointerGesture = (event) => {
    const gesture = gestureRef.current
    gestureRef.current = null

    if (
      !gesture ||
      gesture.ignored ||
      gesture.pointerId !== event.pointerId ||
      stage !== 'active'
    )
      return

    const selectionNow = window.getSelection?.()?.toString() ?? ''
    if (selectionNow && !gesture.selectionAtStart) return

    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    const distance = Math.hypot(dx, dy)

    if (distance < 54) return

    const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI
    let mode
    let direction

    if (angle < 25 || angle > 155) {
      mode = 'horizontal'
      direction = dx > 0 ? 'east' : 'west'
    } else if (angle > 65 && angle < 115) {
      mode = 'vertical'
      direction = dy > 0 ? 'south' : 'north'
    } else {
      mode = dx * dy >= 0 ? 'diagonal-main' : 'diagonal-cross'
      direction =
        dx > 0
          ? dy > 0
            ? 'southeast'
            : 'northeast'
          : dy > 0
            ? 'southwest'
            : 'northwest'
    }

    onSwipe({
      mode,
      direction,
    })
  }

  const cancelPointerGesture = () => {
    gestureRef.current = null
  }

  return (
    <div
      className={cardClassName}
      onPointerDown={handlePointerDown}
      onPointerUp={finishPointerGesture}
      onPointerCancel={cancelPointerGesture}
    >
      <article className={`concept-card concept-card--${mode}`}>
        <MouthBorder
          card={card}
          exitMode={exitMode}
          exitFragments={exitFragments}
        />

        <div
          className="card-content"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="card-header">
            <span>{card.head || card.input || '程序在这里发生了一个意外 但你完全可以放任不管'}</span>
            <span>
              本卡片由<em>⌜{CARD_DISPLAY_NAMES[card.type] ?? card.typeName}⌟</em>引擎生成
            </span>
          </header>

          <div className="card-copy">
          <CardCopy
            card={card}
            active={stage === 'active'}
            onEmptyVisibility={onEmptyVisibility}
            onEmptyRevealComplete={onEmptyRevealComplete}
            onEmptyContinue={onEmptyContinue}
          />
          </div>

          {relationVisible && (
              <RelationPanel
                card={card}
              explanation={card.explanation}
              status={explanationStatus}
                error={explanationError}
                closing={relationLeaving}
            />
          )}

          <div className={actionsClassName}>
            {hasSurfaceMeeting && (
              <button type="button" onClick={onToggleRelation} disabled={emptyStreamBusy}>
                {showingRelation ? '收起解释' : '何以相遇'}
              </button>
            )}
            {hasPulseMeeting && (
              <button
                className={meetingRevealed ? '' : 'card-actions__meeting-pulse'}
                type="button"
                onClick={() => {
                  onMeetingReveal(card.id)
                  onToggleRelation()
                }}
              >
                何以相遇
              </button>
            )}
            <button type="button" onClick={onAvoid} disabled={emptyStreamBusy || mode === 'new'}>
              避开
            </button>
            <button
              className={saved ? 'is-active' : ''}
              type="button"
              onClick={onSave}
            >
              {saved ? '已留印' : '留印'}
            </button>
            {mode !== 'new' && <button className="card-actions__next" type="button" onClick={onNext} disabled={emptyStreamBusy}>
              {mode === 'stay' ? '再遇一则' : '继续探索'} <span aria-hidden="true">↑</span>
            </button>}
          </div>
        </div>

        {saved && <span className="save-stamp">留</span>}
        {exitMode === 'avoid' && <span className="avoid-strike" />}
      </article>
    </div>
  )
}
