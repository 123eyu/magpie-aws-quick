import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickUsage, usageFromEntitlements, planName } from '../lib/usage.mjs'

const RESP = {
  entitlements: [
    { unitType: 'AUTOMATION_AGENT_HOUR_UNIT', numMinsAvailable: 529, numMinsProvisioned: 600 },
    { unitType: 'RESEARCH_AGENT_HOUR_UNIT', numMinsAvailable: 529, numMinsProvisioned: 600 },
  ],
  subscriptionMetadata: { subscriptionType: 'QUICK_LITE_FREE_TRIAL', freeTrialMetadata: { status: 'ACTIVE', expiryDate: 1797865753000 } },
}

test('planName humanizes subscription types', () => {
  assert.equal(planName('QUICK_LITE_FREE_TRIAL'), 'Quick Lite (free trial)')
  assert.equal(planName('QUICK_PRO'), 'Quick Pro')
  assert.equal(planName(''), '')
})

test('entitlements map to one agent-hours window per pool, plan and trial expiry', () => {
  const u = usageFromEntitlements(RESP, { user: 'me@example.com', now: new Date(2026, 10, 22) })
  assert.equal(u.plan, 'Quick Lite (free trial)')
  assert.equal(u.until, new Date(1797865753000).toISOString())
  assert.equal(u.user, 'me@example.com')
  assert.equal(u.windows.length, 1) // identical pools collapse
  const w = u.windows[0]
  assert.equal(w.name, 'Agent hours')
  assert.equal(w.amount, 1.18)
  assert.equal(w.limit, 10)
  assert.equal(w.unit, 'h')
  assert.ok(Math.abs(w.used - (71 / 600) * 100) < 1e-9)
  assert.equal(w.resetsAt, new Date(2026, 11, 1).toISOString())
})

test('quickUsage posts the qbs-event and reads the account from the actor ARN', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).eventType === 'getAvailableEntitlementUnits') seen = { url, init }
    return new Response(JSON.stringify({ errorMessage: null, eventResponse: { getAvailableEntitlementUnitsResponse: RESP } }), { status: 200 })
  }
  const sess = { id_token: 'tok', tenant_url: 'https://tenant.example/', aws_account_id: '123456789012', actor_arn: 'arn:aws:quicksight:us-east-1:123456789012:user/default/me@example.com' }
  const u = await quickUsage(async () => sess, { fetchImpl })
  assert.equal(seen.url, 'https://tenant.example/integration/quick-work/qbs-event')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(seen.init.body), { eventType: 'getAvailableEntitlementUnits', eventBody: { getAvailableEntitlementUnits: { awsAccountId: '123456789012' } } })
  assert.equal(u.user, 'me@example.com')
  assert.equal(u.windows[0].limit, 10)
})

test('quickUsage reports expired sign-in on 401 and errors without leaking the token', async () => {
  const sess = { id_token: 'secret-token', tenant_url: 'https://t.example' }
  const expired = await quickUsage(async () => sess, { fetchImpl: async () => new Response('', { status: 401 }) })
  assert.equal(expired.signIn, 'expired')
  const bad = await quickUsage(async () => sess, { fetchImpl: async () => new Response(JSON.stringify({ errorMessage: 'boom' }), { status: 400 }) })
  assert.match(bad.error, /boom/)
  assert.ok(!JSON.stringify(bad).includes('secret-token'))
})

test('quickUsage merges the session bucket from profile/usage as a minute window', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.eventType === 'invokeAgent') {
      return new Response(JSON.stringify({
        eventResponse: {
          invokeAgentResponse: JSON.stringify({
            status: 200,
            body: JSON.stringify({
              session: { used: 35, limit: 100, resume_in_minutes: 0 },
              monthly: { used: 71, limit: 600 },
              subscription: { subscription_type: 'QUICK_LITE_FREE_TRIAL' },
            }),
          }),
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ eventResponse: { getAvailableEntitlementUnitsResponse: RESP } }), { status: 200 })
  }
  const sess = { id_token: 'tok', tenant_url: 'https://tenant.example/', aws_account_id: '1', actor_arn: 'arn:aws:quicksight:us-east-1:1:user/default/me@example.com' }
  const u = await quickUsage(async () => sess, { fetchImpl })
  assert.equal(u.windows.length, 2)
  const sw = u.windows[0]
  assert.equal(sw.name, 'Session (5h window)')
  assert.equal(sw.unit, 'min')
  assert.equal(sw.amount, 35)
  assert.equal(sw.limit, 100)
  assert.equal(sw.used, 35)
  assert.equal(sw.resetsAt, undefined, 'no reset time while the bucket has capacity')
  assert.equal(u.windows[1].name, 'Agent hours', 'monthly window still present')
})

test('quickUsage sets resetsAt from resume_in_minutes when the session bucket is exhausted', async () => {
  const before = Date.now()
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.eventType === 'invokeAgent') {
      return new Response(JSON.stringify({
        eventResponse: {
          invokeAgentResponse: JSON.stringify({
            status: 200,
            body: JSON.stringify({ session: { used: 100, limit: 100, resume_in_minutes: 42 } }),
          }),
        },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ eventResponse: { getAvailableEntitlementUnitsResponse: RESP } }), { status: 200 })
  }
  const sess = { id_token: 'tok', tenant_url: 'https://tenant.example/', aws_account_id: '1', actor_arn: 'arn:x' }
  const u = await quickUsage(async () => sess, { fetchImpl })
  const resetAt = new Date(u.windows[0].resetsAt).getTime()
  assert.ok(resetAt >= before + 42 * 60000 && resetAt <= Date.now() + 42 * 60000, 'resetsAt ≈ now + 42min')
})

test('quickUsage degrades to monthly-only when profile/usage is unavailable', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (body.eventType === 'invokeAgent') return new Response('not found', { status: 404 })
    return new Response(JSON.stringify({ eventResponse: { getAvailableEntitlementUnitsResponse: RESP } }), { status: 200 })
  }
  const sess = { id_token: 'tok', tenant_url: 'https://tenant.example/', aws_account_id: '1', actor_arn: 'arn:x' }
  const u = await quickUsage(async () => sess, { fetchImpl })
  assert.equal(u.windows.length, 1)
  assert.equal(u.windows[0].name, 'Agent hours')
})
