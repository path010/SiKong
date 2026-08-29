/* Card-centric API server. Every generation is an independent card. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cardsLib from './lib/cards.mjs'
import { getModelConfig, modelStatus, probeModel, setRuntimeModelConfig } from './lib/llm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
function loadDotEnv(name) {
  const file = path.join(__dirname, name)
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}
loadDotEnv('.env')
loadDotEnv('.env.local')

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const MAX_CARDS = Math.max(20, Number(process.env.SIKONG_MAX_CARDS || process.env.SIKONG_MAX_CARD_CACHE || 1000))
const MAX_REQUEST_CACHE = Math.max(20, Number(process.env.SIKONG_MAX_REQUEST_CACHE || 1000))
const MAX_EXPLANATIONS = Math.max(20, Number(process.env.SIKONG_MAX_EXPLANATION_CACHE || 1000))
const MAX_EMPTY_SENTENCES = Math.max(1, Math.min(30, Number(process.env.SIKONG_EMPTY_MAX_SENTENCES || 30)))
const MAX_EMPTY_LENGTH = Math.max(40, Math.min(600, Number(process.env.SIKONG_EMPTY_MAX_LENGTH || 600)))
const SAVED_CARDS_FILE = path.join(__dirname, 'saved-cards.json')
const MODEL_CONFIG_FILE = path.join(__dirname, 'model-config.json')
const DIST_DIR = path.resolve(__dirname, '..', 'dist')
let modelAvailable = false

const CARD_META = cardsLib.CARD_META || {}
const CARD_TYPES = cardsLib.CARD_TYPES || {}
const composeCard = cardsLib.composeCard
const composeExplanation = cardsLib.composeExplanation
const composeBlindPoemMeeting = cardsLib.composeBlindPoemMeeting
const composeBookMeeting = cardsLib.composeBookMeeting
const edgeText = cardsLib.edgeText || ((value, fallback = '') => Array.from(String(value || fallback).trim()).slice(0, 28).join(''))

// Card store is bounded and exists only for canonical explanation, streaming and saving.
const cards = new Map()
const requestCache = new Map()
const inFlight = new Map()
const explanationCache = new Map()
const meetingCache = new Map()
const emptyInFlight = new Set()
let saveQueue = Promise.resolve()

const ALLOWED_ORIGIN = process.env.SIKONG_CORS_ORIGIN || 'http://localhost:5173'
const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  Vary: 'Origin',
  'Access-Control-Allow-Headers': 'Content-Type, X-Session-Id',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
}
const clean = (value, fallback = '') => String(value ?? fallback).replace(/\s+/g, ' ').trim()
const copy = value => value === undefined ? value : JSON.parse(JSON.stringify(value))
const isAbort = (error, signal) => Boolean(signal?.aborted) || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
function abortError() { const error = new Error('请求已取消'); error.name = 'AbortError'; error.code = 'ABORT_ERR'; return error }

function modelConfigError(message) {
  const error = new Error(message)
  error.code = 'INVALID_MODEL_CONFIG'
  return error
}

function publicModelConfig() {
  const current = getModelConfig()
  return {
    provider: current.provider,
    model: current.model,
    baseUrl: current.baseUrl,
    configured: Boolean(current.apiKey),
    available: modelAvailable,
  }
}

async function loadRuntimeModelConfig() {
  if (process.env.SIKONG_IGNORE_MODEL_CONFIG_FILE === '1') return
  if (!existsSync(MODEL_CONFIG_FILE)) return
  try {
    const parsed = JSON.parse(readFileSync(MODEL_CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return
    setRuntimeModelConfig(parsed)
  } catch (error) {
    if (!(error instanceof SyntaxError)) console.warn('[sikong-model] 读取模型配置失败，使用环境变量配置：', error.message)
  }
}

async function persistRuntimeModelConfig(configValue) {
  await writeFile(MODEL_CONFIG_FILE, JSON.stringify(configValue, null, 2), 'utf8')
}

function validateModelConfigInput(body) {
  const current = getModelConfig()
  const provider = String(body?.provider || current.provider || 'deepseek').toLowerCase()
  if (provider !== 'deepseek') throw modelConfigError('当前原生仅支持 DeepSeek')

  const baseUrl = clean(body?.baseUrl, current.baseUrl).replace(/\/+$/, '')
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) throw modelConfigError('模型 Base URL 必须是有效的 http(s) 地址')
  try {
    const parsedUrl = new URL(baseUrl)
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error()
  } catch {
    throw modelConfigError('模型 Base URL 必须是有效的 http(s) 地址')
  }

  const model = clean(body?.model, current.model)
  if (!model || model.length > 120) throw modelConfigError('模型名称不能为空且不能超过120字')

  const apiKey = clean(body?.apiKey)
  const nextApiKey = apiKey || current.apiKey
  if (!nextApiKey) throw modelConfigError('请先填写模型 API Key')

  return {
    provider,
    baseUrl,
    model,
    apiKey: nextApiKey,
  }
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function staticContentType(filePath) {
  return STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false

  const distRoot = `${DIST_DIR}${path.sep}`
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'
  const requested = path.resolve(DIST_DIR, relative)
  if (requested !== DIST_DIR && !requested.startsWith(distRoot)) return false

  const candidates = [requested]
  if (relative === 'index.html' || !path.extname(requested)) candidates.push(path.join(DIST_DIR, 'index.html'))

  for (const candidate of candidates) {
    let info
    try { info = await stat(candidate) } catch { continue }
    if (!info.isFile()) continue

    const isHtml = path.extname(candidate).toLowerCase() === '.html'
    response.writeHead(200, {
      'Content-Type': staticContentType(candidate),
      'Content-Length': info.size,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    if (request.method === 'HEAD') {
      response.end()
      return true
    }

    const stream = createReadStream(candidate)
    stream.on('error', () => {
      if (!response.destroyed && !response.writableEnded) response.destroy()
    })
    stream.pipe(response)
    return true
  }

  return false
}

function requestContext(request, response) {
  const controller = new AbortController()
  const abort = () => { if (!controller.signal.aborted) controller.abort() }
  const onClose = () => { if (!response.writableEnded) abort() }
  request.once('aborted', abort)
  request.once('error', abort)
  response.once('close', onClose)
  return {
    signal: controller.signal,
    cleanup() {
      request.off('aborted', abort)
      request.off('error', abort)
      response.off('close', onClose)
    },
  }
}

function sendJSON(response, status, data) {
  if (response.destroyed || response.writableEnded) return false
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS })
  response.end(JSON.stringify(data))
  return true
}

function publicError(error) {
  if (error?.code === 'PAYLOAD_TOO_LARGE') return '请求内容过大。'
  if (error?.code === 'INVALID_JSON') return '请求体不是合法 JSON。'
  if (error?.code === 'HEAD_TOO_LONG') return '卡片的头不能超过28字。'
  if (error?.code === 'MODEL_NOT_CONFIGURED') return '模型未配置，请先在设置中填写 API Key。'
  if (error?.code === 'INVALID_MODEL_SCHEMA') return '模型返回的内容不符合要求，请稍后重试。'
  if (isAbort(error)) return '请求已取消。'
  return '这次探索暂时没有完成，请稍后重试。'
}

function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(value)
    }
    const onAbort = () => finish(abortError())
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    request.on('data', chunk => {
      if (done) return
      raw += chunk
      if (raw.length > 64_000) {
        const error = new Error('请求体过大')
        error.code = 'PAYLOAD_TOO_LARGE'
        finish(error)
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!raw.trim()) return finish(null, {})
      try { finish(null, JSON.parse(raw)) }
      catch { const error = new Error('JSON'); error.code = 'INVALID_JSON'; finish(error) }
    })
    request.on('error', error => finish(error))
    request.on('aborted', onAbort)
  })
}

function boundedSet(map, key, value, maximum) {
  map.set(key, value)
  while (map.size > maximum) map.delete(map.keys().next().value)
}

function normalizeCard(raw, fallback) {
  const source = copy(raw || {}) || {}
  const type = CARD_META[source.type] ? source.type : fallback.type
  const [typeName, typeNote] = CARD_META[type] || ['司空', '意外探索']
  const head = edgeText(source.head || source.input || fallback.head, '程序在这里发生了一个意外 但你完全可以放任不管')
  const content = source.content && typeof source.content === 'object' ? { ...source.content } : {}
  content.lines = Array.isArray(content.lines) ? content.lines.map(line => edgeText(line)).filter(Boolean).slice(0, MAX_EMPTY_SENTENCES) : []
  content.seed = head
  content.stream = content.lines.join('\n') || clean(content.stream)
  content.streamStatus = clean(content.streamStatus || content.stream_status, type === CARD_TYPES.EMPTY ? 'pending' : 'done')
  content.stream_status = content.streamStatus
  const tail = edgeText(source.tail || content.lines.at(-1) || head, head)
  const surface = source.surface && typeof source.surface === 'object' ? {
    tailReading: clean(source.surface.tailReading).slice(0, 420),
    humanReading: source.surface.humanReading && typeof source.surface.humanReading === 'object'
      ? { title: clean(source.surface.humanReading.title).slice(0, 80), interpret: clean(source.surface.humanReading.interpret).slice(0, 420) }
      : null,
  } : null
  return {
    ...source,
    id: clean(source.id) || randomUUID(),
    type, typeName: clean(source.typeName, typeName), typeNote: clean(source.typeNote, typeNote),
    ordinal: Math.max(1, Number(source.ordinal) || Number(fallback.index || 0) + 1),
    head, input: head, tail,
    time: clean(source.time || source.createdAt, fallback.time || new Date().toISOString()).slice(0, 80),
    createdAt: clean(source.createdAt || source.time, fallback.time || new Date().toISOString()).slice(0, 80),
    entropy: clean(source.entropy, fallback.entropy).slice(0, 120),
    content, surface,
    meetingRevealed: Boolean(source.meetingRevealed),
    explanation: null,
  }
}

function requestKey({ type, head, entropy }) {
  return [cardsLib.PIPELINE_VERSION || 'card-v2', type, head, entropy].join('|')
}

async function generateCard(options) {
  const key = requestKey(options)
  if (requestCache.has(key)) {
    const id = requestCache.get(key)
    const stored = cards.get(id)
    if (stored) return { card: copy(stored), cached: true }
    requestCache.delete(key)
  }
  if (inFlight.has(key)) return { card: copy(await inFlight.get(key)), cached: true }
  if (typeof composeCard !== 'function') throw new Error('卡片生成引擎未加载')
  const promise = Promise.resolve(composeCard(options)).then(raw => normalizeCard(raw, options))
  inFlight.set(key, promise)
  try {
    const card = await promise
    boundedSet(cards, card.id, card, MAX_CARDS)
    boundedSet(requestCache, key, card.id, MAX_REQUEST_CACHE)
    return { card: copy(card), cached: false }
  } finally {
    inFlight.delete(key)
  }
}

async function explain(card, signal) {
  const value = await composeExplanation({ card: { head: card.head, tail: card.tail }, signal })
  const human = value?.humanReading && typeof value.humanReading === 'object' ? value.humanReading : {}
  return {
    humanReading: {
      title: clean(human.title, '一次意外的相遇').slice(0, 80),
      interpret: clean(human.interpret, '它们像在陌生路口擦肩，前一个名字把一小束光递给了后一个名字。').slice(0, 420),
    },
    mode: clean(value?.mode, 'model'),
  }
}

function savedCardSnapshot(card) {
  const head = edgeText(card.head || card.input, '程序在这里发生了一个意外 但你完全可以放任不管')
  const tail = edgeText(card.tail, head)
  const surface = card.surface && typeof card.surface === 'object'
    ? {
        tailReading: clean(card.surface.tailReading).slice(0, 420),
        humanReading: card.surface.humanReading && typeof card.surface.humanReading === 'object'
          ? {
              title: clean(card.surface.humanReading.title).slice(0, 80),
              interpret: clean(card.surface.humanReading.interpret).slice(0, 420),
            }
          : undefined,
      }
    : undefined
  const snapshot = {
    id: clean(card.id),
    savedAt: new Date().toISOString(),
    type: card.type,
    typeName: clean(card.typeName, CARD_META[card.type]?.[0] || '司空'),
    typeNote: clean(card.typeNote, CARD_META[card.type]?.[1] || '意外探索'),
    ordinal: Math.max(1, Number(card.ordinal) || 1),
    head,
    tail,
    explanation: card.explanation ? copy(card.explanation) : null,
    meetingRevealed: Boolean(card.meetingRevealed),
  }
  if (card.type === CARD_TYPES.MAGIC_TONE) {
    snapshot.originWord = clean(card.originWord).slice(0, 20)
    snapshot.misheardWord = clean(card.misheardWord).slice(0, 20)
  }
  if (card.type === CARD_TYPES.UNRULED) {
    snapshot.decomposedWord = clean(card.decomposedWord).slice(0, 20)
    snapshot.decomposedImages = Array.isArray(card.decomposedImages)
      ? card.decomposedImages.map(item => clean(item).slice(0, 20)).filter(Boolean)
      : []
    snapshot.decomposedParts = Array.isArray(card.decomposedParts)
      ? card.decomposedParts.map(item => clean(item).slice(0, 20)).filter(Boolean)
      : []
  }
  if (card.type === CARD_TYPES.WORD_REVERSE) {
    snapshot.oppositePairs = Array.isArray(card.oppositePairs)
      ? card.oppositePairs.map(pair => ({
          source: clean(pair?.source).slice(0, 20),
          opposite: clean(pair?.opposite).slice(0, 20),
        })).filter(pair => pair.source && pair.opposite)
      : []
  }
  if (surface) snapshot.surface = surface
  const special = card.type === CARD_TYPES.EMPTY || card.type === CARD_TYPES.BLIND_POEM || card.type === CARD_TYPES.BOOK_OF_ANSWERS
  if (special) {
    const content = card.content && typeof card.content === 'object' ? card.content : {}
    const lines = Array.isArray(content.lines)
      ? content.lines.map((line) => edgeText(line)).filter(Boolean).slice(0, MAX_EMPTY_SENTENCES)
      : []
    snapshot.content = { lines }
    if (card.type === CARD_TYPES.EMPTY) {
      snapshot.content.stream = lines.join('\n')
      snapshot.content.streamStatus = clean(content.streamStatus || content.stream_status, 'done')
    } else {
      snapshot.content.stream = lines.join('\n')
    }
  }
  return snapshot
}

function saveCardToFile(card) {
  const value = savedCardSnapshot(card)
  const operation = saveQueue.then(async () => {
    let items = []
    try { items = JSON.parse(await readFile(SAVED_CARDS_FILE, 'utf8')) }
    catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (!Array.isArray(items)) items = []
    const index = items.findIndex(item => item?.id === card.id)
    if (index >= 0) items[index] = value
    else items.unshift(value)
    await writeFile(SAVED_CARDS_FILE, JSON.stringify(items, null, 2), 'utf8')
    return value
  })
  saveQueue = operation.catch(() => undefined)
  return operation
}

async function readSavedCards() {
  try {
    const items = JSON.parse(await readFile(SAVED_CARDS_FILE, 'utf8'))
    return Array.isArray(items) ? items : []
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return []
    throw error
  }
}

function removeSavedCardFromFile(cardId) {
  const operation = saveQueue.then(async () => {
    let items = []
    try {
      items = JSON.parse(await readFile(SAVED_CARDS_FILE, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (!Array.isArray(items)) return false
    const nextItems = items.filter(item => item?.id !== cardId)
    if (nextItems.length === items.length) return false
    await writeFile(SAVED_CARDS_FILE, JSON.stringify(nextItems, null, 2), 'utf8')
    return true
  })
  saveQueue = operation.catch(() => undefined)
  return operation
}

async function clearSavedCards() {
  const operation = saveQueue.then(async () => {
    await writeFile(SAVED_CARDS_FILE, JSON.stringify([], null, 2), 'utf8')
    return true
  })
  saveQueue = operation.catch(() => undefined)
  return operation
}

function sse(response, event, data, signal) {
  if (signal.aborted || response.destroyed || response.writableEnded) return false
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  response.flush?.()
  return true
}

async function streamEmpty(response, card, body, context) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS })
  response.flushHeaders?.()
  if (emptyInFlight.has(card.id)) {
    sse(response, 'error', { cardId: card.id, message: '这张空卡正在续写' }, context.signal)
    response.end()
    context.cleanup()
    return
  }
  emptyInFlight.add(card.id)
  const single = body?.single === true
  const force = body?.force === true
  const batch = Math.max(1, Math.min(6, Number(body?.batch) || 3))
  const lines = Array.isArray(card.content?.lines) ? [...card.content.lines].map(edgeText).filter(Boolean) : []
  const initial = edgeText(card.tail || card.head, card.head)
  let previous = lines.at(-1) || initial
  let mode = 'model'
  card.content.streamStatus = 'streaming'
  card.content.stream_status = 'streaming'
  sse(response, 'meta', { cardId: card.id, seed: previous, provider: modelStatus().provider, available: modelAvailable, degraded: !modelAvailable }, context.signal)
  try {
    const rounds = force
      ? Math.min(batch, MAX_EMPTY_SENTENCES - lines.length)
      : single
        ? Math.min(batch, MAX_EMPTY_SENTENCES - lines.length)
        : Math.max(0, MAX_EMPTY_SENTENCES - lines.length)
    for (let index = 0; index < rounds && !context.signal.aborted; index += 1) {
      const result = await cardsLib.generateEmptySentence({ previousSentence: previous, seed: card.head || card.input || initial, signal: context.signal })
      let next = edgeText(result?.sentence || result?.tail, previous)
      mode = result?.mode || 'model'
      if (!next || next === previous) break
      if (!force && Array.from(lines.join('') + next).length > MAX_EMPTY_LENGTH) break
      lines.push(next)
      previous = next
      card.tail = next
      card.content.lines = [...lines]
      card.content.stream = lines.join('\n')
      card.content = { ...card.content, kind: 'empty', lines: [...lines], stream: card.content.stream, streamStatus: 'streaming', stream_status: 'streaming' }
      const chars = Array.from(next)
      for (let offset = 0; offset < chars.length && !context.signal.aborted; offset += 4) {
        if (!sse(response, 'delta', { delta: chars.slice(offset, offset + 4).join(''), sentenceIndex: lines.length - 1 }, context.signal)) break
        await new Promise(resolve => setTimeout(resolve, 18))
      }
      sse(response, 'sentence', { sentence: next, index: lines.length - 1 }, context.signal)
    }
    if (context.signal.aborted) return
    const atLimit = lines.length >= MAX_EMPTY_SENTENCES
    const paused = !force && !atLimit && lines.length < MAX_EMPTY_SENTENCES
    card.content.streamStatus = paused ? 'paused' : 'done'
    card.content.stream_status = card.content.streamStatus
    card.content.atLimit = atLimit
    card.content = { ...card.content, kind: 'empty', lines: [...lines], stream: card.content.stream, streamStatus: card.content.streamStatus, stream_status: card.content.streamStatus, atLimit: card.content.atLimit }
    boundedSet(cards, card.id, card, MAX_CARDS)
    sse(response, 'done', { cardId: card.id, mode, length: Array.from(card.content.stream).length, sentences: lines.length, tail: card.tail, paused, atLimit }, context.signal)
    if (!response.writableEnded && !response.destroyed) response.end()
  } catch (error) {
    if (!isAbort(error, context.signal)) sse(response, 'error', { cardId: card.id, message: publicError(error) }, context.signal)
    if (!response.writableEnded && !response.destroyed) response.end()
  } finally {
    emptyInFlight.delete(card.id)
    context.cleanup()
  }
}

async function handleAPI(request, response, url) {
  const pathname = url.pathname
  if (pathname === '/api/health' && request.method === 'GET') {
    return sendJSON(response, 200, {
      ok: true,
      service: 'sikong-server',
      model: { available: modelAvailable, degraded: !modelAvailable },
    })
  }
  if (pathname === '/api/meta' && request.method === 'GET') {
    return sendJSON(response, 200, {
      cardTypes: Object.fromEntries(Object.entries(CARD_META).map(([key, value]) => [key, { name: value[0], note: value[1] }])),
      model: { ...modelStatus(), available: modelAvailable, degraded: !modelAvailable }, memory: true,
      architecture: 'card-centric', pipelineVersion: cardsLib.PIPELINE_VERSION,
      cache: { cards: cards.size, requests: requestCache.size, explanations: explanationCache.size },
    })
  }
  if (pathname === '/api/model-config' && request.method === 'GET') {
    return sendJSON(response, 200, publicModelConfig())
  }

  const context = requestContext(request, response)
  const cleanup = () => { if (!pathname.endsWith('/stream')) context.cleanup() }
  try {
    if (pathname === '/api/model-config' && request.method === 'POST') {
      const body = await readBody(request, context.signal)
      try {
        const nextConfig = validateModelConfigInput(body)
        await persistRuntimeModelConfig(nextConfig)
        setRuntimeModelConfig(nextConfig)
        const probe = await probeModel()
        modelAvailable = probe.ok
        return sendJSON(response, 200, {
          saved: true,
          config: publicModelConfig(),
          probe: {
            ok: probe.ok,
            provider: probe.provider,
            model: probe.model,
            error: probe.error || null,
          },
        })
      } catch (error) {
        if (error?.code === 'INVALID_MODEL_CONFIG') {
          return sendJSON(response, 400, { error: error.message })
        }
        throw error
      }
    }

    if (pathname === '/api/cards' && request.method === 'POST') {
      const body = await readBody(request, context.signal)
      const rawHead = clean(body.head)
      if (!rawHead) return sendJSON(response, 400, { error: '请提供卡片的头' })
      if (Array.from(rawHead).length > 28 || /[\r\n]/u.test(String(body.head))) {
        return sendJSON(response, 400, { error: '卡片的头不能超过28字' })
      }
      const head = edgeText(rawHead)
      const type = CARD_META[body.type] ? body.type : CARD_TYPES.SAND_SEA
      const entropy = clean(body.entropy, randomUUID()).slice(0, 120)
      const time = clean(body.time, new Date().toISOString()).slice(0, 80)
      const index = Number.isFinite(Number(body.index)) ? Math.max(0, Math.floor(Number(body.index))) : 0
      const result = await generateCard({ head, type, entropy, time, index, signal: context.signal })
      if (context.signal.aborted) return null
      return sendJSON(response, 200, { ...result.card, cached: result.cached })
    }

    const meetingRevealMatch = pathname.match(/^\/api\/cards\/([^/]+)\/meeting-revealed$/)
    if (meetingRevealMatch && request.method === 'POST') {
      const card = cards.get(decodeURIComponent(meetingRevealMatch[1]))
      if (!card) return sendJSON(response, 404, { error: '卡片不存在或已过期' })
      card.meetingRevealed = true
      boundedSet(cards, card.id, card, MAX_CARDS)
      return sendJSON(response, 200, { cardId: card.id, meetingRevealed: true })
    }

    const meetingMatch = pathname.match(/^\/api\/cards\/([^/]+)\/meeting$/)
    if (meetingMatch && request.method === 'POST') {
      const card = cards.get(decodeURIComponent(meetingMatch[1]))
      if (!card || ![CARD_TYPES.BLIND_POEM, CARD_TYPES.BOOK_OF_ANSWERS].includes(card.type)) {
        return sendJSON(response, 404, { error: '卡片不存在或不可解释' })
      }
      const key = card.id
      if (meetingCache.has(key)) {
        const value = copy(meetingCache.get(key))
        card.explanation = copy(value)
        return sendJSON(response, 200, { cardId: card.id, ...value, cached: true })
      }
      const value = card.type === CARD_TYPES.BLIND_POEM
        ? await composeBlindPoemMeeting({ card, signal: context.signal })
        : await composeBookMeeting({ card, signal: context.signal })
      if (context.signal.aborted) return null
      boundedSet(meetingCache, key, copy(value), MAX_EXPLANATIONS)
      card.explanation = copy(value)
      return sendJSON(response, 200, { cardId: card.id, ...value, cached: false })
    }

    const explanationMatch = pathname.match(/^\/api\/cards\/([^/]+)\/explanation$/)
    if (explanationMatch && request.method === 'POST') {
      const card = cards.get(decodeURIComponent(explanationMatch[1]))
      if (!card) return sendJSON(response, 404, { error: '卡片不存在或已过期' })
      const key = card.id
      if (explanationCache.has(key)) {
        const value = copy(explanationCache.get(key))
        return sendJSON(response, 200, { cardId: card.id, ...value, explanation: value, cached: true })
      }
      // Request body is deliberately ignored: canonical head/tail come from the card store.
      const value = await explain(card, context.signal)
      if (context.signal.aborted) return null
      boundedSet(explanationCache, key, copy(value), MAX_EXPLANATIONS)
      card.explanation = copy(value)
      return sendJSON(response, 200, { cardId: card.id, ...value, explanation: copy(value), cached: false })
    }

    const streamMatch = pathname.match(/^\/api\/cards\/([^/]+)\/stream$/)
    if (streamMatch && request.method === 'POST') {
      const card = cards.get(decodeURIComponent(streamMatch[1]))
      if (!card || card.type !== CARD_TYPES.EMPTY) return sendJSON(response, 404, { error: '空卡片不存在' })
      const body = await readBody(request, context.signal)
      return streamEmpty(response, card, body, context)
    }

  if (pathname === '/api/saved-cards' && request.method === 'POST') {
      const body = await readBody(request, context.signal)
      const card = cards.get(clean(body.cardId))
      if (!card) return sendJSON(response, 404, { error: '卡片不存在或已过期' })
      return sendJSON(response, 200, { saved: true, card: await saveCardToFile(card) })
    }
  if (pathname === '/api/saved-cards' && request.method === 'GET') {
    return sendJSON(response, 200, { cards: await readSavedCards() })
  }
  if (pathname === '/api/saved-cards' && request.method === 'DELETE') {
    await clearSavedCards()
    return sendJSON(response, 200, { cleared: true })
  }
  const deleteSavedMatch = pathname.match(/^\/api\/saved-cards\/([^/]+)$/)
  if (deleteSavedMatch && request.method === 'DELETE') {
    const removed = await removeSavedCardFromFile(decodeURIComponent(deleteSavedMatch[1]))
    return sendJSON(response, removed ? 200 : 404, { removed })
  }
    return sendJSON(response, 404, { error: `未知接口：${pathname}` })
  } finally {
    cleanup()
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`)
  try {
    if (request.method === 'OPTIONS') { response.writeHead(204, CORS); return response.end() }
    if (url.pathname.startsWith('/api/')) return await handleAPI(request, response, url)
    if (await serveStatic(request, response, url.pathname)) return
    return sendJSON(response, 404, { error: '司空服务端只提供 /api 接口' })
  } catch (error) {
    if (isAbort(error) || request.aborted || response.destroyed) return
    console.error('[sikong-card]', error)
    return sendJSON(response, 500, { error: publicError(error) })
  }
})

async function start() {
  await loadRuntimeModelConfig()
  const probe = await probeModel()
  modelAvailable = probe.ok

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[sikong-server] 端口 ${HOST}:${PORT} 已被占用，请先关闭占用该端口的进程，或通过 PORT 环境变量指定其他端口。`)
      process.exitCode = 1
      return
    }
    console.error('[sikong-server] 服务启动失败：', error)
    process.exitCode = 1
  })

  server.listen(PORT, HOST, () => {
    console.log(`司空服务端已启动：http://${HOST}:${PORT}`)
    console.log(`模型：${probe.provider}${probe.ok ? '（可用）' : '（不可用）'}`)
    if (!probe.ok && probe.error) console.log(`模型自检失败：${probe.error}`)
  })
}

start().catch((error) => {
  console.error('司空服务端启动失败：', error)
  process.exit(1)
})

export { server, cards, requestCache, explanationCache }
