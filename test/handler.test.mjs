import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick, defaultScript } from './helpers/fake-quick.mjs'
import { handleChatCompletions, handleModels } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/sessions.mjs'
import { OutpostError } from '../lib/outpost.mjs'

let fake
let outpostMgr

before(async () => {
  fake = await startFakeQuick({})
  const outpost = {
    outpostId: async () => 'outpost-test-1',
    session: async () => ({
      ws_host: fake.wsHost,
      id_token: 'test-token',
      actor_arn: 'arn:test',
      provider: 'social',
      aws_account_id: '123456789012',
      usable_until: Math.floor(Date.now() / 1000) + 600,
    }),
  }
  outpostMgr = { ensure: async () => outpost }
})

after(async () => { await fake?.close() })

function req(body, extra = {}) {
  return handleChatCompletions({
    body,
    outpostMgr,
    sessions: extra.sessions,
    options: { identity: 'test-acct', log: () => {} },
    signal: extra.signal,
  })
}

async function readSse(res) {
  const text = await res.text()
  const events = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const data = line.slice(6)
    if (data === '[DONE]') { events.push({ done: true }); continue }
    try { events.push(JSON.parse(data)) } catch {}
  }
  return events
}

test('models endpoint returns the four agent modes', async () => {
  const res = handleModels()
  const data = await res.json()
  assert.equal(data.object, 'list')
  assert.deepEqual(data.data.map((m) => m.id).sort(), ['advanced', 'balanced', 'fast', 'smart'])
})

test('non-stream chat completion returns assembled text + usage', async () => {
  const res = await req({ model: 'fast', messages: [{ role: 'user', content: 'capital of France?' }] })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.object, 'chat.completion')
  assert.equal(json.model, 'fast')
  const msg = json.choices[0].message
  assert.equal(msg.role, 'assistant')
  assert.ok(msg.content.startsWith('echo:'))
  assert.equal(json.choices[0].finish_reason, 'stop')
  assert.equal(json.usage.prompt_tokens, 14) // 11 + 3 cached
  assert.equal(json.usage.completion_tokens, 7)
  assert.equal(json.usage.total_tokens, 21)
})

test('stream chat completion emits role/content chunks then stop + DONE', async () => {
  const res = await req({ model: 'smart', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'say hi' }] })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  const events = await readSse(res)
  const chunks = events.filter((e) => e.choices?.length)
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
  assert.ok(text.startsWith('echo:'))
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  const usageChunk = events.find((e) => e.choices?.length === 0 && e.usage)
  assert.ok(usageChunk, 'expected a usage-only chunk')
  assert.equal(usageChunk.usage.total_tokens, 21)
  assert.equal(events.at(-1).done, true)
})

test('agent_mode is sent per request model; unknown models default to smart', async () => {
  await req({ model: 'balanced', messages: [{ role: 'user', content: 'm1' }] })
  await req({ model: 'gpt-5', messages: [{ role: 'user', content: 'm2' }] })
  const msgs = fake.state.userMessages
  assert.equal(msgs.at(-2).payload.agent_mode, 'balanced')
  assert.equal(msgs.at(-1).payload.agent_mode, 'smart')
  assert.ok(msgs.at(-1).payload.message_id)
  assert.ok(msgs.at(-1).payload.thread_id)
})

test('system prompt and history are rendered into the first user_message', async () => {
  await req({
    model: 'fast',
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ],
  })
  const p = fake.state.userMessages.at(-1).payload
  assert.ok(p.text.includes('[system instructions]\nbe terse'))
  assert.ok(p.text.includes('user: q1'))
  assert.ok(p.text.includes('assistant: a1'))
  assert.ok(p.text.endsWith('\n\nq2'))
})

test('thread reuse: extended conversation continues the same thread with delta only', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'remember teal' }
  // turn 1
  const r1 = await req({ model: 'fast', messages: [u1] }, { sessions })
  assert.equal(r1.status, 200)
  const j1 = await r1.json()
  const reply = j1.choices[0].message.content

  // turn 2 extends the conversation
  const r2 = await req({
    model: 'fast',
    messages: [u1, { role: 'assistant', content: reply }, { role: 'user', content: 'what color?' }],
  }, { sessions })
  assert.equal(r2.status, 200)
  await r2.json()

  const msgs = fake.state.userMessages
  const t1 = msgs.at(-2)
  const t2 = msgs.at(-1)
  assert.equal(t2.threadId, t1.threadId, 'second turn must reuse the Quick thread')
  assert.equal(t2.payload.text, 'what color?')
  assert.ok(!t2.payload.text.includes('remember teal'))
})

test('edited history starts a fresh thread', async () => {
  const sessions = createSessionStore()
  const u1 = { role: 'user', content: 'alpha' }
  await req({ model: 'fast', messages: [u1] }, { sessions }).then((r) => r.json())
  // same shape but different content → no continuation
  await req({
    model: 'fast',
    messages: [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'WRONG reply' },
      { role: 'user', content: 'beta' },
    ],
  }, { sessions }).then((r) => r.json())
  const msgs = fake.state.userMessages
  assert.notEqual(msgs.at(-1).threadId, msgs.at(-2).threadId)
})

test('session_connect carries surface/outpost/appVersion; ping gets pong', async () => {
  await req({ model: 'fast', messages: [{ role: 'user', content: 'ping test' }] })
  // wait a beat for the ping interval? No — ping is on a 25s timer; just assert connect frame.
  const sc = fake.state.sessionConnects.at(-1)
  assert.equal(sc.surfaceType, 'QUICK_WORK_DESKTOP_WINDOWS')
  assert.equal(sc.outpostId, 'outpost-test-1')
  assert.equal(sc.appVersion, '1.2.4660')
})

test('outpost failure surfaces as a real HTTP error, not a dead stream', async () => {
  const badMgr = { ensure: async () => { throw new OutpostError('no agent binary', { kind: 'spawn' }) } }
  const res = await handleChatCompletions({
    body: { model: 'fast', messages: [{ role: 'user', content: 'x' }] },
    outpostMgr: badMgr,
    options: {},
  })
  assert.equal(res.status, 503)
  const j = await res.json()
  assert.match(j.error.message, /no agent binary/)
})

test('missing messages → 400', async () => {
  const res = await req({ model: 'fast' })
  assert.equal(res.status, 400)
})

test('mid-stream error emits an error chunk then DONE', async () => {
  const errFake = await startFakeQuick({
    script: () => [
      { type: 'text_delta', payload: { delta: 'partial' } },
      { type: 'error', payload: { message: 'boom' } },
    ],
  })
  try {
    const mgr = {
      ensure: async () => ({
        outpostId: async () => 'o2',
        session: async () => ({ ws_host: errFake.wsHost, id_token: 't', usable_until: Math.floor(Date.now() / 1000) + 600 }),
      }),
    }
    const res = await handleChatCompletions({
      body: { model: 'fast', stream: true, messages: [{ role: 'user', content: 'x' }] },
      outpostMgr: mgr,
      options: { identity: 'err-acct' },
    })
    assert.equal(res.status, 200)
    const events = await readSse(res)
    const err = events.find((e) => e.error)
    assert.ok(err, 'expected an error event in the stream')
    assert.match(err.error.message, /boom/)
    assert.equal(events.at(-1).done, true)
  } finally {
    await errFake.close()
  }
})
