import { generateJson, modelStatus, isAbortError } from './llm.mjs'
import { randomUUID } from 'node:crypto'
import { PROMPTS } from './prompts.mjs'

export const PIPELINE_VERSION = 'card-v3-2026-08-27'

export const CARD_TYPES = Object.freeze({
  SAND_SEA: 'sand-sea', MAGIC_TONE: 'magic-tone', UNRULED: 'unruled',
  BLIND_POEM: 'blind-poem', BOOK_OF_ANSWERS: 'book-of-answers',
  WORD_REVERSE: 'word-reverse', EMPTY: 'empty',
})

export const CARD_META = Object.freeze({
  [CARD_TYPES.SAND_SEA]: ['沙海', '祂似乎并不在意你想看什么'],
  [CARD_TYPES.MAGIC_TONE]: ['湮律', '这是一场由错听引起的意外'],
  [CARD_TYPES.UNRULED]: ['不守', '将表意单元打散 延申 进而得到意外之物'],
  [CARD_TYPES.BLIND_POEM]: ['盲诗', '两句诗偶然碰到了一起'],
  [CARD_TYPES.BOOK_OF_ANSWERS]: ['全书', '一页书纸意外地飘到你的身前'],
  [CARD_TYPES.WORD_REVERSE]: ['尔反', '恰恰相反 是意料之中 还是意外'],
  [CARD_TYPES.EMPTY]: ['空', ''],
})

const STOP_WORDS = new Set([
  '的', '了', '着', '过', '地', '得', '啊', '呀', '呢', '吧', '吗', '嘛', '么',
  '和', '与', '及', '或', '而', '但', '却', '又', '也', '都', '很', '更', '最',
  '在', '于', '从', '向', '把', '被', '给', '让', '对', '跟', '为', '以', '之',
  '里', '内', '外', '上', '下', '中', '间', '前', '后', '旁',
  '是', '有', '无', '会', '能', '可', '要', '想', '将', '就', '才', '还', '仍',
  '这', '那', '哪', '什么', '怎么', '如何', '为什么', '一个', '一种', '一些',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '自己',
])

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
const codePoints = value => Array.from(String(value ?? ''))
const codePointLength = value => codePoints(value).length

export function edgeText(value, fallback = '') {
  const normalized = clean(value, fallback).replace(/```(?:json)?/gi, '').replace(/^[-*\d.)、\s]+/u, '').split(/[\r\n]/u)[0].trim()
  return codePoints(normalized).slice(0, 28).join('')
}

function schemaError(message) {
  const error = new Error(message)
  error.code = 'INVALID_MODEL_SCHEMA'
  return error
}

function assertEdge(value, name) {
  const normalized = clean(value)
  if (!normalized || codePointLength(normalized) > 20 || /[\r\n]/u.test(String(value))) throw schemaError(name + ' 必须是1到20字的单行文本')
  return normalized
}

function assertObject(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaError('模型结果必须是 JSON 对象')
  const actual = Object.keys(value)
  if (actual.some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !(key in value))) throw schemaError('模型结果字段不符合约定')
  return value
}

function assertArray(value, name, minimum = 1, maximum = 8) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw schemaError(name + ' 数量不符合约定')
  return value
}

function stableNumber(value) {
  let hash = 2166136261
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}
const stablePick = (items, seed) => items[stableNumber(seed) % items.length]

export function tokenizeHead(head) {
  const source = edgeText(head)
  const candidates = []
  try {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    for (const item of segmenter.segment(source)) {
      const text = clean(item.segment)
      if (!item.isWordLike || !text || STOP_WORDS.has(text) || !/[\p{L}\p{N}]/u.test(text)) continue
      candidates.push({ text: edgeText(text), start: item.index, end: item.index + text.length, kind: 'content' })
    }
  } catch {
    const matcher = /[\p{Script=Han}]{1,4}|[A-Za-z0-9]+/gu
    for (const match of source.matchAll(matcher)) {
      const text = clean(match[0])
      if (text && !STOP_WORDS.has(text)) candidates.push({ text: edgeText(text), start: match.index || 0, end: (match.index || 0) + text.length, kind: 'content' })
    }
  }
  const seen = new Set()
  const tokens = candidates.filter(item => item.text && !STOP_WORDS.has(item.text) && !seen.has(item.text) && seen.add(item.text)).slice(0, 12)
  if (tokens.length) return tokens
  const fallback = codePoints(source).filter(char => /[\p{Script=Han}A-Za-z0-9]/u.test(char)).join('') || source || '程序在这里发生了一个意外 但你完全可以放任不管'
  const text = edgeText(fallback)
  return text ? [{ text, start: 0, end: text.length, kind: 'content' }] : []
}

async function generateHumanReading(context, tail) {
  return strictStage('human-story', {
    system: PROMPTS.humanStory,
    user: JSON.stringify({ head: context.head, tail }), maxTokens: 220, temperature: 1.05, signal: context.signal,
  }, validateMeetingReading)
}
const exactLine = payload => { assertObject(payload, ['line']); return { line: assertEdge(payload.line, 'line') } }
const exactSentence = payload => { assertObject(payload, ['sentence']); return { sentence: assertEdge(payload.sentence, 'sentence') } }

function validateTopicAndReading(payload) {
  assertObject(payload, ['topic', 'reading'])
  const reading = clean(payload.reading)
  if (!reading || codePointLength(reading) > 90 || /[\r\n]/u.test(String(payload.reading))) throw schemaError('reading 必须是1到90字的单行文本')
  return { topic: assertEdge(payload.topic, 'topic'), reading }
}

async function strictStage(name, options, validate) {
  let lastError
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const raw = await generateJson({ ...options, stage: name, source: 'cards.mjs:strictStage' })
      return { value: validate(raw), mode: modelStatus().provider, attempts: attempt }
    } catch (error) {
      if (isAbortError(error)) throw error
      lastError = error
    }
  }
  throw lastError
}

async function generateTopic({ input, signal, stage = 'topic', temperature = 1.15 }) {
  return strictStage(stage, {
    system: PROMPTS.topic,
    user: JSON.stringify(input || {}),
    maxTokens: 260,
    temperature,
    signal,
  }, validateTopicAndReading)
}

function validateMishear(payload, selected) {
  assertObject(payload, ['heardAs'])
  const heardAs = assertEdge(payload.heardAs, 'heardAs')
  if (heardAs === selected) throw schemaError('错听结果不能等于原词')
  return { heardAs }
}

function validateUnruled(payload) {
  assertObject(payload, ['parts', 'images'])
  const parts = assertArray(payload.parts, 'parts', 1, 2).map(item => {
    assertObject(item, ['form', 'image'])
    return { form: assertEdge(item.form, 'form'), image: assertEdge(item.image, 'image') }
  })
  const images = assertArray(payload.images, 'images', 1, 2).map(item => assertEdge(item, 'image'))
  return { parts, images }
}

function validateOpposites(payload, words) {
  assertObject(payload, ['pairs'])
  const allowed = new Set(words)
  const seen = new Set()
  const pairs = assertArray(payload.pairs, 'pairs', 1, Math.min(12, words.length || 1)).map(item => {
    assertObject(item, ['source', 'opposite'])
    const source = assertEdge(item.source, 'source')
    const opposite = assertEdge(item.opposite, 'opposite')
    if (!allowed.has(source) || seen.has(source) || source === opposite) throw schemaError('取反映射未通过来源校验')
    seen.add(source)
    return { source, opposite }
  })
  return { pairs }
}

async function generateSand(context) {
  const random = await generateTopic({ input: {}, signal: context.signal, stage: 'sand-topic', temperature: 1.3 })
  const tail = edgeText(random.value.topic)
  const meeting = await generateHumanReading(context, tail)
  return {
    tail,
    surface: { tailReading: random.value.reading, humanReading: { title: meeting.value.title, interpret: meeting.value.story } },
  }
}

async function generateMagicTone(context) {
  const words = context.tokens.map(item => item.text)
  const selected = stablePick(words, context.entropy + ':magic-select')
  const mutation = await strictStage('magic-mishear', {
    system: PROMPTS.magicMishear,
    user: JSON.stringify({ word: selected }), maxTokens: 100, temperature: 1.1, signal: context.signal,
  }, value => validateMishear(value, selected))
  const topic = await generateTopic({ input: { heardAs: mutation.value.heardAs }, signal: context.signal, stage: 'magic-topic', temperature: 1.15 })
  const tail = edgeText(topic.value.topic)
  const meeting = await generateHumanReading(context, tail)
  return {
    tail,
    originWord: selected,
    misheardWord: mutation.value.heardAs,
    surface: { tailReading: topic.value.reading, humanReading: { title: meeting.value.title, interpret: meeting.value.story } },
  }
}

async function generateUnruled(context) {
  const words = context.tokens.map(item => item.text)
  const selected = stablePick(words, context.entropy + ':unruled-select')
  const decomposition = await strictStage('unruled-decompose', {
    system: PROMPTS.unruledDecompose,
    user: JSON.stringify({ word: selected }), maxTokens: 260, temperature: 1.1, signal: context.signal,
  }, validateUnruled)
  const topic = await generateTopic({ input: { images: decomposition.value.images }, signal: context.signal, stage: 'unruled-topic', temperature: 1.15 })
  const tail = edgeText(topic.value.topic)
  const meeting = await generateHumanReading(context, tail)
  return {
    tail,
    decomposedWord: selected,
    decomposedImages: decomposition.value.images,
    decomposedParts: decomposition.value.parts.map(item => item.form),
    surface: { tailReading: topic.value.reading, humanReading: { title: meeting.value.title, interpret: meeting.value.story } },
  }
}

async function generateReverse(context) {
  const words = context.tokens.map(item => item.text)
  const reversed = await strictStage('reverse-words', {
    system: PROMPTS.reverseWords,
    user: JSON.stringify({ words }), maxTokens: 320, temperature: 0.9, signal: context.signal,
  }, value => validateOpposites(value, words))
  const opposites = reversed.value.pairs.map(item => item.opposite)
  const topic = await generateTopic({ input: { opposites }, signal: context.signal, stage: 'reverse-topic', temperature: 1.0 })
  const tail = edgeText(topic.value.topic)
  const meeting = await generateHumanReading(context, tail)
  return {
    tail,
    oppositePairs: reversed.value.pairs,
    surface: { tailReading: topic.value.reading, humanReading: { title: meeting.value.title, interpret: meeting.value.story } },
  }
}

async function generateBlindPoem(context) {
  const firstPromise = strictStage('poem-first', {
    system: PROMPTS.poemFirst,
    user: JSON.stringify({ head: context.head }), maxTokens: 100, temperature: 1.05, signal: context.signal,
  }, exactLine)
  const secondPromise = strictStage('poem-second', {
    system: PROMPTS.poemSecond,
    user: JSON.stringify({}), maxTokens: 100, temperature: 1.25, signal: context.signal,
  }, exactLine)
  const [first, second] = await Promise.all([firstPromise, secondPromise])
  const tail = edgeText(second.value.line)
  return {
    tail, specialContents: { kind: 'blind-poem', lines: [first.value.line, tail] },
    stages: [{ name: 'poem-first', result: first }, { name: 'poem-second', result: second }],
  }
}

async function generateBook(context) {
  const draw = await strictStage('book-draw', {
    system: PROMPTS.bookDraw,
    user: JSON.stringify({}), maxTokens: 100, temperature: 1.25, signal: context.signal,
  }, exactLine)
  const tail = edgeText(draw.value.line)
  return {
    tail, specialContents: { kind: 'book-of-answers', line: tail, lines: [tail] },
    stages: [{ name: 'book-draw', result: draw }],
  }
}

function generateEmpty(context) {
  return {
    tail: context.head, specialContents: { kind: 'empty', lines: [], stream: '', streamStatus: 'pending', stream_status: 'pending' },
    stages: [],
  }
}

function compatContents(type, special, head) {
  if (type === CARD_TYPES.BLIND_POEM || type === CARD_TYPES.BOOK_OF_ANSWERS) return { lines: special.lines, seed: head, stream: '', streamStatus: 'done', stream_status: 'done' }
  if (type === CARD_TYPES.EMPTY) return { lines: [], seed: head, stream: '', streamStatus: 'pending', stream_status: 'pending' }
  return { lines: [], seed: head, stream: '', streamStatus: 'done', stream_status: 'done' }
}

export async function composeCard({ head, seed, type, index = 0, time, entropy, signal } = {}) {
  const safeHead = edgeText(head || seed, '程序在这里发生了一个意外 但你完全可以放任不管')
  const normalizedType = CARD_META[type] ? type : CARD_TYPES.SAND_SEA
  const createdAt = clean(time, new Date().toISOString()).slice(0, 80)
  const entropyValue = clean(entropy, randomUUID()).slice(0, 120)
  const tokens = tokenizeHead(safeHead)
  const context = { head: safeHead, type: normalizedType, createdAt, entropy: entropyValue, tokens, signal }
  let generated
  if (normalizedType === CARD_TYPES.SAND_SEA) generated = await generateSand(context)
  else if (normalizedType === CARD_TYPES.MAGIC_TONE) generated = await generateMagicTone(context)
  else if (normalizedType === CARD_TYPES.UNRULED) generated = await generateUnruled(context)
  else if (normalizedType === CARD_TYPES.WORD_REVERSE) generated = await generateReverse(context)
  else if (normalizedType === CARD_TYPES.BLIND_POEM) generated = await generateBlindPoem(context)
  else if (normalizedType === CARD_TYPES.BOOK_OF_ANSWERS) generated = await generateBook(context)
  else generated = generateEmpty(context)

  const [typeName, typeNote] = CARD_META[normalizedType]
  const tail = edgeText(generated.tail, safeHead)
  const contents = generated.specialContents
  return {
    id: randomUUID(), type: normalizedType, typeName, typeNote,
    ordinal: Math.max(1, Number(index) + 1 || 1), head: safeHead, input: safeHead, tail,
    time: createdAt, createdAt, entropy: entropyValue, tokens, contents,
    surface: generated.surface || null,
    meetingRevealed: false,
    content: compatContents(normalizedType, generated.specialContents || {}, safeHead),
    explanation: null,
    originWord: generated.originWord,
    misheardWord: generated.misheardWord,
    decomposedWord: generated.decomposedWord,
    decomposedImages: generated.decomposedImages,
    decomposedParts: generated.decomposedParts,
    oppositePairs: generated.oppositePairs,
  }
}

function validateMeetingReading(payload) {
  assertObject(payload, ['title', 'story'])
  const title = assertEdge(payload.title, 'title')
  const story = clean(payload.story)
  if (!story || codePointLength(story) > 160 || /[\r\n]/u.test(payload.story)) throw schemaError('story 必须是1到160字的单行文本')
  return { title, story }
}

function validateMeetingExplanation(payload) {
  assertObject(payload, ['explanation'])
  const explanation = clean(payload.explanation)
  if (!explanation || codePointLength(explanation) > 120 || /[\r\n]/u.test(payload.explanation)) throw schemaError('explanation 必须是1到120字的单行文本')
  return { explanation }
}

export async function composeExplanation({ card, signal } = {}) {
  const reading = await strictStage('human-story', {
    system: PROMPTS.humanStory,
    user: JSON.stringify({ head: card?.head, tail: card?.tail }), maxTokens: 220, temperature: 1.05, signal,
  }, validateMeetingReading)
  return {
    humanReading: {
      title: reading.value.title,
      interpret: reading.value.story,
    },
    mode: reading.mode,
  }
}

export async function composeBlindPoemMeeting({ card, signal } = {}) {
  const head = edgeText(card?.head || card?.input, '程序在这里发生了一个意外 但你完全可以放任不管')
  const firstLine = edgeText(card?.content?.lines?.[0], head)
  const secondLine = edgeText(card?.content?.lines?.[1] || card?.tail, firstLine)
  const reading = await strictStage('poem-meeting', {
    system: PROMPTS.poemReading,
    user: JSON.stringify({ firstLine, secondLine }), maxTokens: 220, temperature: 0.95, signal,
  }, validateMeetingExplanation)
  return {
    kind: 'blind-poem-meeting',
    title: '两句诗意外地碰到一起',
    explanation: reading.value.explanation,
    mode: reading.mode,
  }
}

export async function composeBookMeeting({ card, signal } = {}) {
  const head = edgeText(card?.head || card?.input, '程序在这里发生了一个意外 但你完全可以放任不管')
  const answer = edgeText(card?.content?.lines?.[0] || card?.tail, '程序在这里发生了一个意外 但你完全可以放任不管')
  const reading = await strictStage('book-reading', {
    system: PROMPTS.bookReading,
    user: JSON.stringify({ head, answer }), maxTokens: 220, temperature: 0.95, signal,
  }, validateMeetingExplanation)
  return {
    kind: 'book-meeting',
    title: '一页书纸意外地飘到你眼前',
    explanation: reading.value.explanation,
    mode: reading.mode,
  }
}

export async function generateEmptySentence({ previousSentence, seed, signal } = {}) {
  const previous = edgeText(previousSentence || seed, '程序在这里发生了一个意外 但你完全可以放任不管')
  const origin = edgeText(seed || previous, previous)
  const result = await strictStage('empty-next', {
    system: PROMPTS.emptyNext,
    user: JSON.stringify({ seed: origin, previous }), maxTokens: 100, temperature: 0.9, signal,
  }, exactSentence)
  const sentence = edgeText(result.value.sentence, previous)
  return { sentence, tail: sentence, mode: result.mode, attempts: result.attempts }
}
