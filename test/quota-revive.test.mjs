// Issue #19: an exhaustion window must not be a pure countdown. While it
// runs, requests trigger adaptive re-probes of profile/usage — capacity
// revives the account immediately, fresh resume times correct the window,
// and failed probes leave it untouched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { quotaCooldownLeft, resetQuotaWindows, seedQuotaWindowForTest } from '../lib/handler.mjs'

let server
let port
let handlerImpl
let hits

before(async () => {
  server = http.createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => handlerImpl(req, res, body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})

after(async () => { await new Promise((r) => server.close(r)) })

function usageResponse(profileBody) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      eventResponse: {
        invokeAgentResponse: JSON.stringify({ status: 200, body: JSON.stringify(profileBody) }),
      },
    }))
  }
}

const getSession = async () => ({ tenant_url: `http://127.0.0.1:${port}`, id_token: 'tok' })

function setup() {
  resetQuotaWindows()
  hits = 0
  // window with 30min left, last probe long ago → first call probes immediately
  seedQuotaWindowForTest('acct', { until: Date.now() + 30 * 60000, exhaustedAt: 0, probedAt: 0 })
}

test('re-probe revives the account when buckets have capacity again', async () => {
  setup()
  handlerImpl = usageResponse({
    session: { used: 10, limit: 100, resume_in_minutes: 0 },
    monthly: { used: 100, limit: 600 },
  })
  const left = await quotaCooldownLeft('acct', getSession, () => {})
  assert.equal(left, 0, 'window must clear on capacity')
  assert.equal(hits, 1, 'exactly one probe')
  // and stays clear
  assert.equal(await quotaCooldownLeft('acct', getSession, () => {}), 0)
  assert.equal(hits, 1, 'no further probes once revived')
})

test('re-probe corrects the window with fresh resume_in_minutes', async () => {
  setup()
  handlerImpl = usageResponse({
    session: { used: 100, limit: 100, resume_in_minutes: 42 },
    monthly: { used: 100, limit: 600 },
  })
  const left = await quotaCooldownLeft('acct', getSession, () => {})
  assert.ok(left > 40 && left <= 42, `window corrected to ~42min, got ${left}`)
  assert.equal(hits, 1)
})

test('a failed probe leaves the window untouched', async () => {
  setup()
  handlerImpl = (req, res) => { res.writeHead(500); res.end('boom') }
  const left = await quotaCooldownLeft('acct', getSession, () => {})
  assert.ok(left > 29 && left <= 30, `window stands at ~30min, got ${left}`)
  assert.equal(hits, 1)
})

test('probe interval is respected — recent probe means no HTTP call', async () => {
  resetQuotaWindows()
  hits = 0
  seedQuotaWindowForTest('acct', { until: Date.now() + 30 * 60000, probedAt: Date.now() })
  handlerImpl = usageResponse({ session: { used: 0, limit: 100 } })
  const left = await quotaCooldownLeft('acct', getSession, () => {})
  assert.ok(left > 29 && left <= 30)
  assert.equal(hits, 0, 'no probe inside the interval')
})

test('without getSession the check stays a pure countdown', async () => {
  setup()
  handlerImpl = usageResponse({ session: { used: 0, limit: 100 } })
  const left = await quotaCooldownLeft('acct')
  assert.ok(left > 29 && left <= 30)
  assert.equal(hits, 0)
})
