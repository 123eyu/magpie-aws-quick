// Native Amazon Quick account login (browser OAuth, no desktop app needed).
//
// Replays the same OIDC dance the desktop app performs at sign-in:
//
//   https://quick.aws.com/sn?qwSurface=desktop:<nonce>:<port>:<appVersion>
//     → browser login (Amazon resolves the account/tenant)
//     → GET 127.0.0.1:<port>/callback?nonce&issuerUrl&tenantUrl&idcRegion…
//     → POST oidc.<idcRegion>.amazonaws.com/client/register  (dynamic client)
//     → 302 → oidc.<idcRegion>.amazonaws.com/authorize (PKCE)
//     → GET 127.0.0.1:<port>/?code&state
//     → POST oidc.<idcRegion>.amazonaws.com/token          (code exchange)
//     → POST <tenant>/integration/quick-work/user-info
//     → session {jwt:id_token, ws_host, actor_arn, …} saved to a config file
//
// The saved session drives the chat WS directly — no outpost, no desktop app.
// Refresh uses grantType:"refresh_token" on the same OIDC token endpoint and
// is written back to the file so rotated refresh tokens survive restarts.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export class OAuthError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message)
    this.name = 'OAuthError'
    this.status = status
    this.kind = kind // 'auth' | 'timeout' | 'http' | 'abort'
  }
}

const APP_VERSION = '1.2.4660'
const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

const SOCIAL_DISCOVERY = {
  prod: 'https://quick.aws.com/sn',
  beta: 'https://devtest.quicksuite.aws.dev/sn',
  integ: 'https://devtest.quicksuite.aws.dev/sn',
  dev: 'https://devtest.quicksuite.aws.dev/sn',
}
const SOCIAL_DATA_PLANE = {
  prod: 'https://cell001.dp.appintegrations.us-east-1.prod.plato.ai.aws.dev',
  beta: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  integ: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
  dev: 'https://cell001.dp.appintegrations.us-west-2.beta.plato.ai.aws.dev',
}
const SOCIAL_SCOPES = { prod: 'quicksight:read_write', beta: 'quicksight_test:read_write', integ: 'quicksight_test:read_write', dev: 'quicksight_test:read_write' }

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const rand = () => b64url(randomBytes(32))
const pkce = () => {
  const verifier = rand()
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

function decodeJwt(token) {
  try {
    const part = token.split('.')[1]
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

const oneLine = (v) => String(v ?? '').split(/\s+/).join(' ').trim()

async function postJson(fetchImpl, url, body, headers = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new OAuthError(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`, { status: res.status, kind: 'http' })
  let parsed
  try { parsed = JSON.parse(text) } catch (e) { throw new OAuthError(`invalid JSON from ${new URL(url).host}: ${e?.message}`, { kind: 'http' }) }
  if (!parsed || typeof parsed !== 'object') throw new OAuthError(`unexpected JSON from ${new URL(url).host}`, { kind: 'http' })
  return parsed
}

function normalizeUserInfo(raw) {
  if (raw && typeof raw.userInfo === 'object') raw = raw.userInfo
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw?.[k]
      if (v != null && v !== '') return oneLine(v)
    }
    return ''
  }
  return {
    email: pick('email', 'emailAddress'),
    user_name: pick('userName', 'user_name', 'username'),
    first_name: pick('firstName', 'first_name'),
    last_name: pick('lastName', 'last_name'),
    display_name: pick('displayName', 'display_name'),
    user_arn: pick('userArn', 'user_arn'),
    quicksight_external_user_arn: pick('quicksightExternalUserArn', 'quicksight_external_user_arn'),
    role: pick('role'),
    identity_type: pick('identityType', 'identity_type'),
    aws_account_id: pick('awsAccountId', 'aws_account_id', 'accountId'),
    account_name: pick('accountName', 'account_name'),
    external_id: pick('externalId', 'external_id'),
    account_ownership: pick('accountOwnership', 'account_ownership'),
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Result pages are a small branded card (dark glass panel + status badge) —
// kept deliberately distinct from a stock browser/system page.
const page = ({ icon, tone, title, children }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;
 font-family:"Avenir Next","Segoe UI",system-ui,sans-serif;color:#e8ecf4;
 background:radial-gradient(900px 480px at 50% -12%,rgba(59,130,246,.35),transparent 65%),#0a0f1c}
.card{width:min(26rem,100%);padding:2.4rem 2rem 2rem;border-radius:1.25rem;text-align:center;
 background:rgba(17,24,39,.72);border:1px solid rgba(148,163,184,.16);
 box-shadow:0 24px 70px rgba(0,0,0,.5);backdrop-filter:blur(10px)}
.ring{width:3.4rem;height:3.4rem;margin:0 auto 1.1rem;border-radius:50%;
 display:grid;place-items:center;font-size:1.5rem;font-weight:700}
.ok{background:rgba(52,211,153,.12);color:#6ee7b7;border:1px solid rgba(52,211,153,.35)}
.bad{background:rgba(248,113,113,.12);color:#fca5a5;border:1px solid rgba(248,113,113,.35)}
.wait{background:rgba(96,165,250,.12);color:#93c5fd;border:1px solid rgba(96,165,250,.35)}
h1{font-size:1.2rem;margin:.1rem 0 .55rem;font-weight:650;letter-spacing:.01em}
.sub{color:#8b96ab;font-size:.86rem;line-height:1.55}
.acct{display:inline-block;margin:.35rem 0 .8rem;padding:.28rem .7rem;border-radius:999px;
 background:rgba(59,130,246,.12);border:1px solid rgba(96,165,250,.25);
 color:#bfdbfe;font-size:.82rem;word-break:break-all}
.err{margin-top:.4rem;padding:.6rem .8rem;border-radius:.6rem;text-align:left;
 background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.22);
 color:#fecaca;font-size:.78rem;line-height:1.45;word-break:break-word}
</style></head><body><main class="card"><div class="ring ${tone}">${icon}</div><h1>${esc(title)}</h1>${children}</main></body></html>`

const successPage = (who) => page({
  icon: '✓', tone: 'ok', title: 'Signed in to Amazon Quick',
  children: `${who ? `<span class="acct">${esc(who)}</span>` : ''}<p class="sub">Login complete — you can return to magpie now; this window is no longer needed.</p>`,
})
const failPage = (msg) => page({
  icon: '!', tone: 'bad', title: 'Sign-in did not complete',
  children: `<div class="err">${esc(msg)}</div><p class="sub">Close this window and start the login again from magpie.</p>`,
})
const waitingPage = () => page({
  icon: '…', tone: 'wait', title: 'Finish signing in',
  children: `<p class="sub">Complete the Amazon login in the tab that opened <code>quick.aws.com</code> — this page only confirms the result.</p>`,
})

// ---------------------------------------------------------------- store ----

/** Where OAuth sessions live (contains refresh tokens — keep private). */
export function defaultStoreDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'magpie-aws-quick')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'magpie-aws-quick')
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'magpie-aws-quick')
}

/**
 * JSON file store for OAuth sessions, keyed by magpie account key.
 * Persisting refresh tokens locally is required — OIDC refresh tokens can
 * rotate, so refreshed credentials must survive a magpie restart.
 */
export function createSessionStore({ dir } = {}) {
  const d = dir || defaultStoreDir()
  const file = path.join(d, 'oauth-sessions.json')
  const read = () => {
    try {
      const db = JSON.parse(readFileSync(file, 'utf8'))
      return db && typeof db === 'object' && db.accounts && typeof db.accounts === 'object' ? db : { accounts: {} }
    } catch {
      return { accounts: {} }
    }
  }
  const write = (db) => {
    mkdirSync(d, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(db, null, 2) + '\n')
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, file)
    try { chmodSync(file, 0o600) } catch {}
  }
  return {
    file,
    get: (key) => read().accounts[key],
    set: (key, sess) => { const db = read(); db.accounts[key] = sess; write(db) },
    remove: (key) => { const db = read(); delete db.accounts[key]; write(db) },
    list: () => Object.keys(read().accounts),
  }
}

// ------------------------------------------------------------- refresh ----

const endpointCache = new Map()

/** Resolve the OIDC token endpoint: discovery doc first, regional fallback. */
async function tokenEndpointFor(sess, fetchImpl) {
  const issuer = sess?.client?.issuer_url || sess?.issuer_url || ''
  if (issuer) {
    if (!endpointCache.has(issuer)) {
      let ep = null
      try {
        const r = await fetchImpl(`${issuer}/.well-known/openid-configuration`)
        if (r.ok) ep = (await r.json())?.token_endpoint || null
      } catch {}
      endpointCache.set(issuer, ep)
    }
    const ep = endpointCache.get(issuer)
    if (ep) return ep
  }
  const idc = sess?.client?.idc_region || sess?.region || 'us-east-1'
  return `https://oidc.${idc}.amazonaws.com/token`
}

/** Refresh the stored OAuth session via grantType:refresh_token; mutates `sess`. */
export async function refreshSession(sess, { fetchImpl = fetch } = {}) {
  const rt = sess?.tokens?.refresh_token
  if (!rt) throw new OAuthError('stored session has no refresh_token; log in again', { status: 401, kind: 'auth' })
  const endpoint = await tokenEndpointFor(sess, fetchImpl)
  const tok = await postJson(fetchImpl, endpoint, {
    clientId: sess.client?.client_id || '',
    clientSecret: sess.client?.client_secret || '',
    grantType: 'refresh_token',
    refreshToken: rt,
  })
  const access = tok.accessToken || tok.access_token || ''
  if (!access) throw new OAuthError('refresh returned no accessToken; log in again', { status: 401, kind: 'auth' })
  const idToken = tok.idToken || tok.id_token || ''
  const expiresIn = Number(tok.expiresIn ?? tok.expires_in ?? 0)
  const claims = decodeJwt(idToken)
  const now = Math.floor(Date.now() / 1000)
  sess.tokens = {
    access_token: access,
    refresh_token: tok.refreshToken || tok.refresh_token || rt,
    id_token: idToken,
    expires_in: expiresIn,
  }
  sess.jwt = idToken || access
  sess.usable_until = expiresIn ? now + expiresIn : (Number(claims.exp) || sess.usable_until || 0)
  sess.obtained_at = now
  // best-effort: refresh the account descriptor too (arn may matter)
  try {
    const base = String(sess.tenant_url || '').replace(/\/+$/, '')
    if (base) sess.user_info = normalizeUserInfo(await postJson(fetchImpl, `${base}/integration/quick-work/user-info`, {}, { Authorization: `Bearer ${access}` }))
  } catch {}
  return sess
}

// ------------------------------------------------------------ login flow ----

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

async function defaultOpen(url) {
  const args = process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url]
    : process.platform === 'darwin' ? ['open', url]
      : ['xdg-open', url]
  const child = spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Start the browser OAuth login without opening a browser. Resolves, once the
 * localhost callback server is listening, to { url, done, cancel }:
 *   url     the quick.aws.com/sn sign-in URL to give the user
 *   done    Promise<session> — the saved-session object shaped for
 *           createSessionStore().set(key, sess); rejects on failure/timeout/cancel
 *   cancel  abort the wait (same as an AbortSignal: OAuthError kind 'abort',
 *           server closed)
 * Rejects if the callback server cannot listen.
 *
 * @param {object} p
 * @param {string}  [p.stage]       build stage (prod default)
 * @param {number}  [p.port]        callback port (default: free port)
 * @param {number}  [p.timeoutMs]   how long to wait for the browser (default 10min)
 * @param {AbortSignal} [p.signal]  cancel the wait
 * @param {Function} [p.fetchImpl]  injectable fetch (tests)
 * @param {Function} [p.log]
 */
export async function startOAuthLogin({ stage = 'prod', port, timeoutMs = LOGIN_TIMEOUT_MS, signal, fetchImpl = fetch, log = () => {}, appVersion = APP_VERSION, surface = SURFACE } = {}) {
  const state = rand()
  const nonce = rand()
  const { verifier, challenge } = pkce()
  const listenPort = port || (await freePort())
  // AWS OIDC public clients only accept loopback redirect URIs with an empty
  // path — the code lands on "/"; a bare "/" visit (no OAuth params) shows the
  // waiting page instead.
  const redirectUri = `http://127.0.0.1:${listenPort}`
  const scopes = SOCIAL_SCOPES[stage] || SOCIAL_SCOPES.prod

  const params = { discovery: {}, client_id: '', client_secret: '', tokens: {}, user_info: {}, tenant_url: '' }

  // cancel() and an outer AbortSignal share the one abort path.
  const ac = new AbortController()
  const onOuterAbort = () => ac.abort()
  if (signal?.aborted) ac.abort()
  else signal?.addEventListener('abort', onOuterAbort, { once: true })

  let resolveParams, rejectParams
  const paramsDone = new Promise((resolve, reject) => { resolveParams = resolve; rejectParams = reject })

  const started = new Promise((resolve, reject) => {
    let finished = false
    // A failure before the listen callback rejects startOAuthLogin itself;
    // after it, only `done` (paramsDone) rejects — resolve(url) already ran.
    const failWait = (err) => { rejectParams(err); reject(err) }
    const done = (fn, arg) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onOuterAbort)
      try { server.close() } catch {}
      fn(arg)
    }
    const reply = (res, status, body) => {
      const data = Buffer.from(body)
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
      res.end(data)
    }
    const fail = (res, msg, status = 400) => {
      reply(res, status, failPage(msg))
      log(`[oauth] ${msg}`)
      done(failWait, new OAuthError(msg, { kind: 'auth', status }))
    }

    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${listenPort}`)
        if (u.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
        if (u.pathname === '/callback') {
          const q = u.searchParams
          if (q.get('nonce') !== nonce) return fail(res, 'Discovery nonce mismatch (stale login link?)')
          if (q.get('error')) return fail(res, `Login failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          params.discovery = {
            issuer_url: q.get('issuerUrl') || q.get('issuer_url') || q.get('issuer') || '',
            tenant_url: q.get('tenantUrl') || q.get('tenant_url') || '',
            account: q.get('account') || '',
            idc_instance_id: q.get('idcInstanceId') || q.get('idc_instance_id') || '',
            idc_region: q.get('idcRegion') || q.get('idc_region') || '',
          }
          params.tenant_url = params.discovery.tenant_url
          if (!params.discovery.issuer_url) return fail(res, 'discovery callback did not provide issuerUrl')
          const idcRegion = params.discovery.idc_region || 'us-east-1'
          const client = await postJson(fetchImpl, `https://oidc.${idcRegion}.amazonaws.com/client/register`, {
            clientName: 'AmazonQuick-Desktop',
            clientType: 'public',
            scopes: [scopes],
            grantTypes: ['authorization_code', 'refresh_token'],
            redirectUris: [redirectUri],
            issuerUrl: params.discovery.issuer_url,
          }).catch((e) => { throw new OAuthError(`client registration failed: ${e?.message ?? e}`, { kind: 'http' }) })
          params.client_id = client.clientId || client.client_id || ''
          params.client_secret = client.clientSecret || client.client_secret || ''
          if (!params.client_id) return fail(res, 'client registration returned no clientId', 502)
          params.discovery.idc_region = idcRegion
          const authUrl = new URL(`https://oidc.${idcRegion}.amazonaws.com/authorize`)
          authUrl.searchParams.set('response_type', 'code')
          authUrl.searchParams.set('client_id', params.client_id)
          authUrl.searchParams.set('redirect_uri', redirectUri)
          authUrl.searchParams.set('scope', scopes)
          authUrl.searchParams.set('state', state)
          authUrl.searchParams.set('code_challenge', challenge)
          authUrl.searchParams.set('code_challenge_method', 'S256')
          res.writeHead(302, { Location: authUrl.toString(), 'Cache-Control': 'no-store' })
          res.end()
          return
        }
        if (u.pathname === '/' || u.pathname === '/index.html') {
          const q = u.searchParams
          const isCallback = q.has('code') || q.has('state') || q.has('error')
          if (!isCallback) { reply(res, 200, waitingPage()); return }
          if (q.get('error')) return fail(res, `Sign-in failed: ${q.get('error')} ${q.get('error_description') || ''}`.trim())
          if (q.get('state') !== state) return fail(res, 'OAuth state mismatch')
          const code = q.get('code')
          if (!code) return fail(res, 'OAuth callback has no code')
          const idcRegion = params.discovery.idc_region || 'us-east-1'
          const tok = await postJson(fetchImpl, `https://oidc.${idcRegion}.amazonaws.com/token`, {
            clientId: params.client_id,
            clientSecret: params.client_secret,
            grantType: 'authorization_code',
            code,
            redirectUri,
            codeVerifier: verifier,
          }).catch((e) => { throw new OAuthError(`token exchange failed: ${e?.message ?? e}`, { kind: 'http' }) })
          params.tokens = {
            access_token: tok.accessToken || tok.access_token || '',
            refresh_token: tok.refreshToken || tok.refresh_token || '',
            id_token: tok.idToken || tok.id_token || '',
            expires_in: Number(tok.expiresIn ?? tok.expires_in ?? 0),
          }
          if (!params.tokens.id_token && !params.tokens.access_token) return fail(res, 'token response has no idToken/accessToken', 502)
          const base = String(params.tenant_url || '').replace(/\/+$/, '') || SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
          const infoBase = base.includes('dp.appintegrations') ? base : (SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod)
          params.user_info = normalizeUserInfo(await postJson(fetchImpl, `${infoBase}/integration/quick-work/user-info`, {}, {
            Authorization: `Bearer ${params.tokens.access_token}`,
          }).catch((e) => { throw new OAuthError(`user-info failed: ${e?.message ?? e}`, { kind: 'http' }) }))
          const display = params.user_info.email || params.user_info.display_name || params.user_info.user_name || ''
          reply(res, 200, successPage(display))
          done(resolveParams, params)
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      } catch (e) {
        fail(res, String(e?.message ?? e), 502)
      }
    })
    server.on('error', (e) => done(failWait, new OAuthError(`cannot listen on 127.0.0.1:${listenPort}: ${e?.message ?? e}`, { kind: 'http' })))
    const timer = setTimeout(() => done(failWait, new OAuthError(`timed out waiting for the browser login (${Math.round(timeoutMs / 60000)} min)`, { kind: 'timeout' })), timeoutMs)
    timer.unref?.()
    const onCancel = () => done(failWait, new OAuthError('login cancelled', { kind: 'abort' }))
    if (ac.signal.aborted) onCancel()
    else ac.signal.addEventListener('abort', onCancel, { once: true })
    if (!finished) server.listen(listenPort, '127.0.0.1', () => {
      const discoverBase = SOCIAL_DISCOVERY[stage] || SOCIAL_DISCOVERY.prod
      const surface_ = encodeURIComponent(`desktop:${nonce}:${listenPort}:${appVersion}`)
      const url = `${discoverBase}?qwSurface=${surface_}`
      log(`[oauth] sign-in URL (open it in this machine's browser): ${url}`)
      log('[oauth] waiting for the browser login…')
      resolve(url)
    })
  })

  const done = paramsDone.then((p) => buildSession(p, { stage }))
  done.catch(() => {}) // an un-awaited done must not trip unhandledRejection
  const url = await started
  return { url, done, cancel: () => ac.abort() }
}

/**
 * Run the full browser OAuth login, opening the sign-in URL in the default
 * browser. Resolves a saved-session object shaped for
 * createSessionStore().set(key, sess).
 *
 * @param {object} p  same options as startOAuthLogin, plus:
 * @param {Function} [p.openBrowser] injectable browser opener (tests; may return the URL)
 */
export async function runOAuthLogin(opts = {}) {
  const { url, done } = await startOAuthLogin(opts)
  const open = opts.openBrowser ?? defaultOpen
  const log = opts.log ?? (() => {})
  Promise.resolve().then(() => open(url)).catch(() => log('[oauth] could not open a browser; use the URL above'))
  return done
}

/** Assemble the stored-session record from a completed login. */
export function buildSession(p, { stage = 'prod' } = {}) {
  let tenant = String(p.tenant_url || p.discovery?.tenant_url || '').replace(/\/+$/, '')
  if (!tenant) tenant = SOCIAL_DATA_PLANE[stage] || SOCIAL_DATA_PLANE.prod
  if (!/^https?:\/\//.test(tenant)) tenant = `https://${tenant}`
  const ws_host = new URL(tenant).host
  if (!ws_host) throw new OAuthError('cannot derive ws_host from tenant_url', { kind: 'auth', status: 401 })
  const jwt = p.tokens.id_token || p.tokens.access_token || ''
  if (!jwt) throw new OAuthError('token response has no id_token/access_token', { kind: 'auth', status: 401 })
  const claims = decodeJwt(p.tokens.id_token || '')
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = Number(p.tokens.expires_in) || 0
  const usable_until = expiresIn ? now + expiresIn : (Number(claims.exp) || 0)
  let actor_arn = p.user_info?.user_arn || ''
  if (!actor_arn && typeof claims.sub === 'string' && claims.sub.startsWith('arn:')) actor_arn = claims.sub
  return {
    provider: 'social',
    stage,
    tenant_url: tenant,
    ws_host,
    jwt,
    actor_arn,
    aws_account_id: p.user_info?.aws_account_id || claims.aws_account_id || '',
    account_name: p.user_info?.account_name || '',
    email: p.user_info?.email || '',
    display_name: p.user_info?.display_name || '',
    region: p.discovery?.idc_region || 'us-east-1',
    usable_until,
    obtained_at: now,
    user_info: p.user_info || {},
    tokens: { ...p.tokens },
    client: {
      client_id: p.client_id || '',
      client_secret: p.client_secret || '',
      idc_region: p.discovery?.idc_region || '',
      issuer_url: p.discovery?.issuer_url || '',
    },
    discovery: { ...p.discovery },
  }
}

/** Deterministic account key so re-login refreshes the same magpie account. */
export function keyForSession(sess) {
  const who = sess?.email || sess?.actor_arn || sess?.user_info?.user_arn || sess?.tenant_url || ''
  return `oauth-${createHash('sha256').update(who || rand()).digest('hex').slice(0, 16)}`
}

// ------------------------------------------------------- direct backend ----

/**
 * A session source with the same surface the chat path needs (Outpost-like):
 *   ensure() → self   session() → sncs-session-shaped object   outpostId() → ''
 * The chat WS accepts an empty outpostId and both token types we can produce
 * (OIDC id_token JWT, or the stored `aoa…` access token).
 *
 * `load()` returns the persisted session record (or null); `persist(sess)`
 * writes it back after a refresh so rotated tokens survive restarts.
 */
export function createDirectBackend({ load, persist, fetchImpl = fetch, log = () => {} }) {
  let cached = null
  let refreshing = null
  const sncsShape = (s) => ({
    id_token: s.jwt,
    ws_host: s.ws_host,
    actor_arn: s.actor_arn || '',
    provider: s.provider || 'social',
    aws_account_id: s.aws_account_id || '',
    account_name: s.account_name || '',
    tenant_url: s.tenant_url || '',
    region: s.region || 'us-east-1',
    usable_until: s.usable_until || 0,
  })
  const backend = {
    direct: true,
    options: {},
    async ensure() {
      const s = await load()
      if (!s) throw new OAuthError('session missing — log in again', { status: 401, kind: 'auth' })
      cached = s
      return backend
    },
    async session() {
      let s = cached || (await load())
      if (!s?.jwt) throw new OAuthError('session missing — log in again', { status: 401, kind: 'auth' })
      const now = Math.floor(Date.now() / 1000)
      if (s.usable_until && s.usable_until - now > 120) { cached = s; return sncsShape(s) }
      if (!s.tokens?.refresh_token) {
        // no refresh material: try the stored jwt; the server will 401 if dead
        if (s.jwt) { cached = s; return sncsShape(s) }
        throw new OAuthError('OAuth session expired and no refresh_token — log in again', { status: 401, kind: 'auth' })
      }
      refreshing ??= refreshSession(s, { fetchImpl }).then(async (fresh) => {
        await persist?.(fresh)
        cached = fresh
        log('[oauth] token refreshed')
        return fresh
      }).finally(() => { refreshing = null })
      const fresh = await refreshing
      return sncsShape(fresh)
    },
    async outpostId() { return '' },
    async status() {
      const s = cached || await Promise.resolve().then(load).catch(() => null)
      return { logged_in: Boolean(s?.jwt), user: s?.email || s?.display_name || '' }
    },
    async stop() {},
  }
  return backend
}
