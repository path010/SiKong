import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockPort = 22000 + (process.pid % 8000)
const serverPort = mockPort + 1
const apiBase = `http://127.0.0.1:${serverPort}/api`
const savedCardsFile = path.join(serverDir, 'saved-cards.json')
const savedCardsExisted = existsSync(savedCardsFile)
const savedCardsBefore = savedCardsExisted ? readFileSync(savedCardsFile) : null
const llmCalls = []
let invalidMishearSchema = false
let emptySentenceIndex = 0
let poemUpperStartedAt = 0
let poemLowerStartedAt = 0
let releasePoemPair = null
let poemPairBarrier = null

const HEAD = '灯塔和旧车票在雨里'
const TIME = '2026-08-27T12:34:56.789Z'
const EXPECTED_MODEL_CALLS = Object.freeze({
  'sand-sea': 2,
  'magic-tone': 3,
  unruled: 3,
  'word-reverse': 3,
  'blind-poem': 2,
  'book-of-answers': 1,
  empty: 0,
})

const pause = duration => new Promise(resolve => setTimeout(resolve, duration))
const codePointLength = value => Array.from(String(value ?? '')).length

const readBody = request => new Promise((resolve, reject) => {
  let raw = ''
  request.on('data', chunk => { raw += chunk })
  request.on('end', () => {
    try { resolve(raw ? JSON.parse(raw) : {}) }
    catch (error) { reject(error) }
  })
  request.on('error', reject)
})

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function parseUser(user) {
  const value = JSON.parse(user)
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), '模型 user 消息必须是 JSON 对象')
  return value
}

function assertExactKeys(object, keys, label) {
  assert.deepEqual(Object.keys(object).sort(), [...keys].sort(), `${label} 收到非约定字段`)
}

function llmContent(system, user) {
  const input = parseUser(user)

  if (system.includes('错听器')) {
    assertExactKeys(input, ['word'], '湮律错听')
    if (invalidMishearSchema) return { heardAs: '越界错听词', leaked: HEAD }
    return { heardAs: '错听岛' }
  }
  if (system.includes('拆字器')) {
    assertExactKeys(input, ['word'], '不守拆字')
    return { parts: [{ form: '木', image: '会呼吸的门' }], images: ['会呼吸的门'] }
  }
  if (system.includes('逐词取反器')) {
    assertExactKeys(input, ['words'], '尔反取反')
    return { pairs: input.words.map((source, index) => ({ source, opposite: `反向词${index + 1}` })) }
  }
  if (system.includes('话题联想器')) {
    if (Object.keys(input).length === 0) {
      assertExactKeys(input, [], '沙海')
      return { topic: '独立潮汐钟', reading: '一座只属于潮汐的钟，把没人听见的时间重新排成一条小路。' }
    }
    if ('heardAs' in input) {
      assertExactKeys(input, ['heardAs'], '湮律生题')
      assert.equal(input.heardAs === '错听岛' || typeof input.heardAs === 'string', true)
      return { topic: '错听岛夜航图', reading: '错听之后的海岸线重新发光，夜航图开始标记那些本不该存在的码头。' }
    }
    if ('images' in input) {
      assertExactKeys(input, ['images'], '不守生题')
      assert.deepEqual(input.images, ['会呼吸的门'])
      return { topic: '会呼吸的门牌', reading: '一扇会呼吸的门，门牌每天换一个方向，像房间在练习怎样迎接陌生人。' }
    }
    if ('opposites' in input) {
      assertExactKeys(input, ['opposites'], '尔反造句')
      assert.ok(input.opposites.every(word => /^反向词\d+$/u.test(word)))
      return { topic: '反向词的清晨', reading: '反向词醒来的清晨，所有习惯都先倒着试一遍，再决定哪条路值得走。' }
    }
  }
  if (system.includes('诗化的上句')) {
    assertExactKeys(input, ['head'], '盲诗上片')
    return { line: '旧车票落进雨里' }
  }
  if (system.includes('负责写下句')) {
    assertExactKeys(input, [], '盲诗下片')
    return { line: '月光折起空站台' }
  }
  if (system.includes('你是答案之书。')) {
    assertExactKeys(input, [], '全书')
    return { line: '今天绕开熟路' }
  }
  if (system.includes('双盲诗解释器')) {
    assertExactKeys(input, ['firstLine', 'secondLine'], '盲诗相遇解释')
    return { explanation: '两行诗在同一个空白处各自醒了过来。' }
  }
  if (system.includes('答案之书解释器')) {
    assertExactKeys(input, ['head', 'answer'], '全书相遇解释')
    return { explanation: '这页书正好从你原本的问题旁边经过。' }
  }
  if (system.includes('意外联想器')) {
    assertExactKeys(input, ['head', 'tail'], '何以相遇')
    return { title: '雨夜交换路灯', story: '它们在雨夜交换了各自的路灯。' }
  }
  if (system.includes('克制的续写器')) {
    assertExactKeys(input, ['seed', 'previous'], '空卡续写')
    emptySentenceIndex += 1
    return { sentence: `第${emptySentenceIndex}句移到新场景` }
  }
  throw new Error(`未覆盖的模型提示：${system}`)
}

function poemBarrier(system) {
  if (!system.includes('诗化的上句') && !system.includes('负责写下句')) return null
  if (!poemPairBarrier) {
    poemPairBarrier = new Promise(resolve => { releasePoemPair = resolve })
  }
  if (system.includes('诗化的上句')) poemUpperStartedAt = Date.now()
  else poemLowerStartedAt = Date.now()
  if (poemUpperStartedAt && poemLowerStartedAt) releasePoemPair()
  return poemPairBarrier
}

const mockServer = createServer(async (request, response) => {
  try {
    const body = await readBody(request)
    if (request.url === '/v1/chat/completions') {
      assert.deepEqual(body.messages?.map(item => item.role), ['system', 'user'])
      const system = String(body.messages[0]?.content || '')
      const user = String(body.messages[1]?.content || '')
      if (system.includes('连通性探针')) {
        return sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] })
      }
      const call = { system, user, input: parseUser(user), body, receivedAt: Date.now() }
      llmCalls.push(call)
      const content = llmContent(system, user)
      const barrier = poemBarrier(system)
      if (barrier) await Promise.race([barrier, pause(500)])
      return sendJson(response, 200, { choices: [{ message: { content: JSON.stringify(content) } }] })
    }

    return sendJson(response, 404, { error: 'not found' })
  } catch (error) {
    return sendJson(response, 500, { error: error.message })
  }
})

await new Promise((resolve, reject) => {
  mockServer.once('error', reject)
  mockServer.listen(mockPort, '127.0.0.1', resolve)
})

const serverProcess = spawn(process.execPath, ['server.mjs'], {
  cwd: serverDir,
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(serverPort),
    SIKONG_LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_MODEL: 'mock-model',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    SIKONG_LLM_TIMEOUT: '5000',
    SIKONG_IGNORE_MODEL_CONFIG_FILE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLogs = ''
serverProcess.stdout.on('data', chunk => { serverLogs += chunk })
serverProcess.stderr.on('data', chunk => { serverLogs += chunk })

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}/health`)
      if (response.ok) return
    } catch {}
    await pause(80)
  }
  throw new Error('mock contract 服务端未能启动')
}

async function rawRequest(pathname, options = {}) {
  const response = await fetch(`${apiBase}${pathname}`, options)
  const payload = await response.json()
  return { response, payload }
}

async function requestJson(pathname, options = {}) {
  const result = await rawRequest(pathname, options)
  assert.equal(result.response.ok, true, `${pathname}: ${JSON.stringify(result.payload)}`)
  return result.payload
}

async function createCard(type, overrides = {}) {
  return requestJson('/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ head: HEAD, type, time: TIME, entropy: `entropy-${type}`, ...overrides }),
  })
}

function callsSince(start) { return llmCalls.slice(start) }

function identify(call) {
  const system = call.system
  if (system.includes('错听器')) return 'magic-mishear'
  if (system.includes('拆字器')) return 'unruled-decompose'
  if (system.includes('话题联想器')) return call.input && Object.keys(call.input).length === 0
    ? 'sand-topic'
    : Object.hasOwn(call.input, 'heardAs') ? 'magic-topic'
      : Object.hasOwn(call.input, 'images') ? 'unruled-topic' : 'reverse-topic'
  if (system.includes('逐词取反器')) return 'reverse-words'
  if (system.includes('诗化的上句')) return 'poem-first'
  if (system.includes('负责写下句')) return 'poem-second'
  if (system.includes('双盲诗解释器')) return 'poem-meeting'
  if (system.includes('答案之书解释器')) return 'book-meeting'
  if (system.includes('意外联想器')) return 'human-story'
  if (system.includes('克制的续写器')) return 'empty-next'
  if (system.includes('答案之书。')) return 'book-draw'
  return 'unknown'
}

function assertEdge(card) {
  assert.ok(codePointLength(card.head) <= 28)
  assert.ok(codePointLength(card.tail) <= 28)
  assert.equal(/[\r\n]/u.test(card.head + card.tail), false)
}

function assertNoSemanticLeak(call, card, forbidden = []) {
  const serialized = JSON.stringify(call.input)
  assert.equal(serialized.includes(card.head), false, `${identify(call)} 泄漏完整 head`)
  for (const value of forbidden) assert.equal(serialized.includes(value), false, `${identify(call)} 泄漏隔离字段 ${value}`)
}

function parseSse(source) {
  return source.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    let event = 'message'
    const data = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    return { event, data: data.length ? JSON.parse(data.join('\n')) : null }
  })
}

try {
  await waitForServer()

  // Meta is a local endpoint and must never spend a model request.
  let start = llmCalls.length
  const meta = await requestJson('/meta')
  assert.equal(meta.architecture, 'card-centric')
  assert.equal(llmCalls.length, start)

  const cards = new Map()
  for (const type of Object.keys(EXPECTED_MODEL_CALLS)) {
    start = llmCalls.length
    const card = await createCard(type, {
      feedback: { action: 'next', cardId: 'FEEDBACK_SECRET_CANARY' },
    })
    cards.set(type, card)
    const calls = callsSince(start)
    assert.equal(calls.length, EXPECTED_MODEL_CALLS[type], `${type} 模型调用次数错误：${calls.map(identify)}`)
    assertEdge(card)
    assert.equal(calls.some(call => JSON.stringify(call.input).includes('FEEDBACK_SECRET_CANARY')), false)
  }

  const sand = cards.get('sand-sea')
  const sandCall = llmCalls.find(call => identify(call) === 'sand-topic')
  assertExactKeys(sandCall.input, [], '沙海最终审计')
  assertNoSemanticLeak(sandCall, sand)

  const magic = cards.get('magic-tone')
  const magicCalls = llmCalls.filter(call => ['magic-mishear', 'magic-topic'].includes(identify(call))).slice(0, 2)
  assertExactKeys(magicCalls[0].input, ['word'], '湮律第一阶段')
  assert.equal(codePointLength(magicCalls[0].input.word) <= 20, true)
  assertExactKeys(magicCalls[1].input, ['heardAs'], '湮律第二阶段')
  assert.equal(magicCalls[1].input.heardAs, '错听岛')
  assertNoSemanticLeak(magicCalls[1], magic, [magicCalls[0].input.word])

  const unruled = cards.get('unruled')
  const unruledCalls = llmCalls.filter(call => ['unruled-decompose', 'unruled-topic'].includes(identify(call))).slice(0, 2)
  assertExactKeys(unruledCalls[0].input, ['word'], '不守第一阶段')
  assert.ok(Array.isArray(unruled.decomposedParts) && unruled.decomposedParts.length > 0)
  assert.ok(unruled.decomposedParts.every(part => typeof part === 'string' && part.length > 0))
  assert.deepEqual(unruledCalls[1].input.images, ['会呼吸的门'])
  assertNoSemanticLeak(unruledCalls[1], unruled, [unruledCalls[0].input.word])

  const reversed = cards.get('word-reverse')
  const reverseCalls = llmCalls.filter(call => ['reverse-words', 'reverse-topic'].includes(identify(call))).slice(0, 2)
  assertExactKeys(reverseCalls[1].input, ['opposites'], '尔反第二阶段')
  assertNoSemanticLeak(reverseCalls[1], reversed)
  for (const source of reverseCalls[0].input.words) {
    assert.equal(reverseCalls[1].input.opposites.includes(source), false)
  }

  const poem = cards.get('blind-poem')
  const poemCalls = llmCalls.filter(call => ['poem-first', 'poem-second'].includes(identify(call))).slice(0, 2)
  assert.deepEqual(poemCalls.find(call => identify(call) === 'poem-first').input, { head: poem.head })
  const lowerCall = poemCalls.find(call => identify(call) === 'poem-second')
  assertExactKeys(lowerCall.input, [], '盲诗下片')
  assertNoSemanticLeak(lowerCall, poem, [poem.content.lines[0]])
  assert.equal(poem.tail, poem.content.lines[1])
  assert.ok(poemUpperStartedAt && poemLowerStartedAt, '盲诗两条请求都必须启动')
  assert.ok(Math.abs(poemUpperStartedAt - poemLowerStartedAt) < 400, '盲诗上下片必须并发请求')

  const book = cards.get('book-of-answers')
  const bookCall = llmCalls.find(call => identify(call) === 'book-draw')
  assertExactKeys(bookCall.input, [], '全书')
  assertNoSemanticLeak(bookCall, book)

  const poemMeeting = await requestJson(`/cards/${encodeURIComponent(poem.id)}/meeting`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal('steps' in poemMeeting, false)
  assert.equal(poemMeeting.title, '两句诗意外地碰到一起')
  assert.equal(poemMeeting.explanation, '两行诗在同一个空白处各自醒了过来。')

  const bookMeeting = await requestJson(`/cards/${encodeURIComponent(book.id)}/meeting`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  assert.equal('steps' in bookMeeting, false)
  assert.equal(bookMeeting.title, '一页书纸意外地飘到你眼前')
  assert.equal(bookMeeting.explanation, '这页书正好从你原本的问题旁边经过。')

  // An explicit entropy identifies one independent card; retrying it is a pure cache hit.
  start = llmCalls.length
  const idempotentBody = { head: '显式熵测试', type: 'sand-sea', entropy: 'EXPLICIT_ENTROPY_ONLY' }
  const first = await requestJson('/cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(idempotentBody),
  })
  const callsAfterFirst = llmCalls.length
  await pause(5)
  const second = await requestJson('/cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(idempotentBody),
  })
  assert.equal(callsAfterFirst - start, EXPECTED_MODEL_CALLS['sand-sea'])
  assert.equal(llmCalls.length, callsAfterFirst)
  assert.equal(second.id, first.id)
  assert.equal(second.cached, true)

  // The mechanism chain is local. The only explanation-model input is canonical head/tail.
  const explanationStart = llmCalls.length
  const explanation = await requestJson(`/cards/${encodeURIComponent(magic.id)}/explanation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      head: 'FORGED_HEAD_CANARY', tail: 'FORGED_TAIL_CANARY',
      reasoning: 'FORGED_REASONING_CANARY', results: 'FORGED_RESULTS_CANARY',
    }),
  })
  const explanationCalls = callsSince(explanationStart)
  assert.equal(explanationCalls.length, 1)
  assert.equal(identify(explanationCalls[0]), 'human-story')
  assert.deepEqual(explanationCalls[0].input, { head: magic.head, tail: magic.tail })
  assert.equal(explanationCalls[0].user.includes('FORGED_'), false)
  assert.equal(explanationCalls[0].user.includes('reasoning'), false)
  assert.equal(explanationCalls[0].user.includes('provenance'), false)
  assert.equal('mechanismChain' in explanation, false)
  assert.equal(explanation.humanReading.interpret, '它们在雨夜交换了各自的路灯。')
  const cachedExplanation = await requestJson(`/cards/${encodeURIComponent(magic.id)}/explanation`, { method: 'POST' })
  assert.equal(cachedExplanation.cached, true)
  assert.equal(llmCalls.length, explanationStart + 1)

  // Saving is by id. A forged browser snapshot cannot replace canonical data.
  const beforeSaveCalls = llmCalls.length
  const saved = await requestJson('/saved-cards', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cardId: magic.id,
      card: { id: magic.id, head: 'FORGED_SAVED_HEAD', tail: 'FORGED_SAVED_TAIL' },
    }),
  })
  assert.equal(saved.saved, true)
  assert.equal(saved.card.head, magic.head)
  assert.equal(saved.card.tail, magic.tail)
  assert.equal(JSON.stringify(saved.card).includes('FORGED_SAVED'), false)
  assert.equal(llmCalls.length, beforeSaveCalls)

  // Empty generation trusts only the canonical server card, then only its latest sentence.
  const empty = cards.get('empty')
  emptySentenceIndex = 0
  const emptyStart = llmCalls.length
  let expectedPrevious = empty.tail
  for (let round = 1; round <= 3; round += 1) {
    const response = await fetch(`${apiBase}/cards/${encodeURIComponent(empty.id)}/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ single: true, previous: 'FORGED_PREVIOUS_CANARY', seed: 'FORGED_SEED_CANARY' }),
    })
    assert.equal(response.ok, true)
    const streamEvents = parseSse(await response.text())
    const call = llmCalls.at(-1)
    assert.equal(identify(call), 'empty-next')
    assert.deepEqual(call.input, { seed: empty.head, previous: expectedPrevious })
    assert.equal(call.user.includes('FORGED_'), false)
    const sentence = streamEvents.find(item => item.event === 'sentence')?.data.sentence
    const done = streamEvents.find(item => item.event === 'done')?.data
    assert.equal(codePointLength(sentence) <= 20, true)
    assert.equal(done.tail, sentence)
    expectedPrevious = sentence
  }
  assert.equal(llmCalls.length - emptyStart, 3)

  // Strict schema: an extra field is rejected twice. The model is available, so the
  // request must fail instead of silently falling back.
  invalidMishearSchema = true
  start = llmCalls.length
  const failedResponse = await rawRequest('/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ head: '严格结构测试', type: 'magic-tone', entropy: 'invalid-schema', feedback: null }),
  })
  invalidMishearSchema = false
  const failedCalls = callsSince(start)
  assert.equal(failedResponse.response.status, 500)
  assert.deepEqual(failedCalls.map(identify), ['magic-mishear', 'magic-mishear'])
  assert.match(failedResponse.payload.error, /模型返回的内容不符合要求/)

  const legacy = await rawRequest('/journeys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed: HEAD }),
  })
  assert.equal(legacy.response.status, 404)

  console.log('司空 mock 契约测试通过：七类调用次数、严格 schema、上下文隔离、28字边界、本地机制链、空卡权威状态与 entropy 幂等均正常。')
} catch (error) {
  if (serverLogs.trim()) console.error(serverLogs.trim())
  throw error
} finally {
  if (serverProcess.exitCode === null) {
    const exited = once(serverProcess, 'exit').catch(() => [])
    serverProcess.kill('SIGTERM')
    await Promise.race([exited, pause(1000)])
  }
  await new Promise(resolve => mockServer.close(resolve))
  if (savedCardsBefore) writeFileSync(savedCardsFile, savedCardsBefore)
}
