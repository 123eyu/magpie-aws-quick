// Regression for issue #16: account A → B → A failover must not lose the
// mid-conversation. The fourth turn reuses A's original thread (the strict
// chain hit proves the exact position) and injects the foreign turns as
// transcript text instead of sending only the final user message.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startFakeQuick } from './helpers/fake-quick.mjs'
import { handleChatCompletions } from '../lib/handler.mjs'
import { createSessionStore } from '../lib/sessions.mjs'

let fake
let outpostMgr
let sessions

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
  sessions = createSessionStore()
})

after(async () => { await fake?.close() })

function turn(identity, messages) {
  return handleChatCompletions({
    body: { model: 'fast', messages },
    outpostMgr,
    sessions,
    options: { identity, log: () => {}, sessionKey: 'chat-1' },
  })
}

test('cross-account failover injects foreign turns into the reused thread (#16)', async () => {
  const m1 = { role: 'user', content: '任务一' }
  const m2 = { role: 'user', content: '新决定：先验收原型' }
  const m3 = { role: 'user', content: '原型已构建' }
  const m4 = { role: 'user', content: '继续' }

  const r1 = await turn('acct-A', [m1])
  assert.equal(r1.status, 200)
  const a1 = { role: 'assistant', content: (await r1.json()).choices[0].message.content }

  const r2 = await turn('acct-B', [m1, a1, m2])
  assert.equal(r2.status, 200)
  const a2 = { role: 'assistant', content: (await r2.json()).choices[0].message.content }

  const r3 = await turn('acct-B', [m1, a1, m2, a2, m3])
  assert.equal(r3.status, 200)
  const a3 = { role: 'assistant', content: (await r3.json()).choices[0].message.content }

  const before = fake.state.userMessages.length
  const r4 = await turn('acct-A', [m1, a1, m2, a2, m3, a3, m4])
  assert.equal(r4.status, 200)
  await r4.text()

  const sent = fake.state.userMessages[before]?.payload
  assert.ok(sent, 'turn 4 must reach upstream')
  // the strict chain hit reuses turn 1's thread on account A
  assert.equal(sent.thread_id, fake.state.userMessages[0].payload.thread_id)
  // …and the foreign turns ride along as transcript instead of being dropped
  assert.ok(sent.text.includes('新决定：先验收原型'), 'B-side user decision must survive')
  assert.ok(sent.text.includes('assistant:'), 'foreign assistant replies render as transcript')
  assert.ok(sent.text.includes('continued elsewhere'), 'header note explains the injection')
  assert.ok(sent.text.trimEnd().endsWith('继续'), 'the final user message is the current turn')
})

test('same-account continuation still sends only the bare delta', async () => {
  const m1 = { role: 'user', content: '单独会话' }
  const r1 = await turn('acct-C', [m1])
  assert.equal(r1.status, 200)
  const a1 = { role: 'assistant', content: (await r1.json()).choices[0].message.content }

  const before = fake.state.userMessages.length
  const r2 = await turn('acct-C', [m1, a1, { role: 'user', content: '追问' }])
  assert.equal(r2.status, 200)
  await r2.text()

  const sent = fake.state.userMessages[before]?.payload
  assert.ok(sent)
  assert.equal(sent.thread_id, fake.state.userMessages[before - 1].payload.thread_id)
  assert.equal(sent.text, '追问')
})
