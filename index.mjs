/**
 * magpie-aws-quick — your Amazon Quick (AWS Quick desktop) login as a magpie / OpenCode provider.
 *
 * magpie sends this provider OpenAI Chat Completions (npm "@ai-sdk/openai-compatible");
 * the loader's fetch answers them by driving the same bidi WebSocket the desktop
 * client uses (see lib/quickws.mjs + lib/handler.mjs).
 *
 * Sign-in is keyless: the plugin spawns (or reuses) the Quick desktop app's own
 * bundled backend — `quickwork-agent --outpost-only`, extracted from the app's
 * agent.zip or already unpacked under the app's userData dir — and reads the
 * session it holds in the OS credential store. You must be signed in to Amazon
 * Quick in the desktop app first; there is no API key to paste.
 *
 * Options (magpie plugin options aws-quick '{…}'), all optional:
 *   agentPath    explicit path to quickwork-agent(.exe)
 *   agentZip     explicit path to the app's resources/agent.zip (extracted on demand)
 *   userDataDir  app userData dir to probe for an already-extracted agent/
 *   cacheDir     where to extract agent.zip (default <tmp>/magpie-aws-quick)
 *   port         fixed outpost port (default: a free loopback port)
 *   buildStage   QUICKWORK_BUILD_STAGE for the spawned backend (default prod)
 *   profileStage QUICKWORK_PROFILE_STAGE (default = buildStage)
 *   surfaceType  WS surfaceType (default QUICK_WORK_DESKTOP_WINDOWS)
 *   appVersion   WS appVersion (default 1.2.4660)
 *   channel      WS channel hint (beta|prod)
 *   sessionReuse continue Quick threads across turns (default true)
 *   sessionTtlMs forget a cached thread state after this long unused (default 1800000)
 *   sessionMax   at most this many cached thread states (default 200)
 *   log          function(line) for plugin diagnostics
 *
 * Models are Quick's agent modes, not raw model ids:
 *   fast / balanced / smart / advanced  (X-Magpie-Effort maps to thinking_effort)
 */
import { createOutpostManager } from './lib/outpost.mjs'
import { handleChatCompletions, handleModels } from './lib/handler.mjs'
import { createSessionStore, SESSION_DEFAULTS } from './lib/sessions.mjs'
import { MODELS } from './lib/translate.mjs'

const PROVIDER = 'aws-quick'
// Requests never reach this address: the loader's fetch intercepts them.
const BASE = 'https://quick.aws.com/magpie-aws-quick/v1'

const BASE_MODEL = {
  limit: { context: 200000, output: 64000 },
  // Quick's own agent tools run server-side; OpenAI-style function calling is
  // layered on top as a <tool_call> text convention (lib/tools.mjs).
  tool_call: true,
  api: { url: BASE, npm: '@ai-sdk/openai-compatible' },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, image: false, audio: false, video: false, pdf: false },
    output: { text: true },
    interleaved: false,
  },
}

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return null
  }
}

async function readBody(input, init) {
  let raw = init?.body
  if (raw == null && input instanceof Request) raw = await input.text()
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
  if (typeof raw !== 'string') raw = raw == null ? '' : String(raw)
  return JSON.parse(raw || '{}')
}

function headerOf(input, init, name) {
  try {
    const own = init?.headers ? new Headers(init.headers).get(name) : null
    return own ?? (input instanceof Request ? input.headers.get(name) : null) ?? undefined
  } catch {
    return undefined
  }
}

/** Stable per-account identity for thread-reuse scoping (hashed, never stored raw). */
async function identityFor(outpost, fallback) {
  try {
    const s = await outpost.session()
    const who = [s?.provider, s?.aws_account_id, s?.actor_arn, s?.tenant_url].filter(Boolean).join(':')
    if (who) return `${fallback}|${who}`
  } catch {}
  return fallback
}

function makeFetch(outpostMgr, opts, sessions) {
  return async function quickFetch(input, init) {
    const url = requestUrl(input)
    const path = url?.pathname ?? ''
    if (/\/models\/?$/.test(path) && (init?.method ?? 'GET').toUpperCase() === 'GET') {
      return handleModels()
    }
    if (!/\/chat\/completions\/?$/.test(path)) {
      return new Response(JSON.stringify({ error: { message: `aws-quick 插件只支持 chat/completions（收到 ${path}）`, type: 'invalid_request_error' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    let body
    try {
      body = await readBody(input, init)
    } catch {
      return new Response(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    const outpost = await outpostMgr.ensure().catch((e) => ({ __err: e }))
    if (outpost?.__err) {
      const e = outpost.__err
      return new Response(JSON.stringify({ error: { message: e?.message ?? String(e), type: 'api_error', code: 503 } }), { status: 503, headers: { 'content-type': 'application/json' } })
    }
    const identity = await identityFor(outpost, opts.identityKey || 'aws-quick')
    return handleChatCompletions({
      body,
      outpostMgr,
      sessions,
      options: { ...opts, identity },
      effortHeader: headerOf(input, init, 'x-magpie-effort'),
      signal: init?.signal,
    })
  }
}

function makeSessions(opts) {
  if (opts.sessionReuse === false || opts.sessionReuse === 'false' || opts.sessionReuse === 0) return undefined
  const ttlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_DEFAULTS.ttlMs
  const max = Number(opts.sessionMax) > 0 ? Math.floor(Number(opts.sessionMax)) : SESSION_DEFAULTS.max
  return createSessionStore({ ttlMs, max })
}

export const AwsQuickAuthPlugin = async (_input, options) => {
  const opts = options && typeof options === 'object' ? options : {}
  const outpostMgr = createOutpostManager(opts)
  const sessions = makeSessions(opts)
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'AWS Quick',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 1,
      methods: [
        {
          // No prompts and no key field: magpie calls authorize directly, which
          // boots the bundled outpost and checks whether the desktop app's
          // sign-in is visible to it.
          type: 'api',
          keyless: true,
          label: '本地获取（Amazon Quick 桌面端登录态）',
          labels: { zh: '本地获取（Amazon Quick 桌面端登录态）', 'zh-TW': '本機獲取（Amazon Quick 桌面端登錄態）' },
          authorize: async () => {
            try {
              const outpost = await outpostMgr.ensure()
              const st = await outpost.status()
              if (!st?.logged_in && !st?.user) {
                return { type: 'failed', error: 'Amazon Quick 桌面端未登录：请先打开 Amazon Quick 登录，再重试' }
              }
              // Force a session mint now so sign-in problems surface here, not
              // on the first chat request.
              await outpost.session({ fresh: true })
              return { type: 'success', key: 'aws-quick-local' }
            } catch (e) {
              return {
                type: 'failed',
                error: `无法连接 Amazon Quick 后端：${String(e?.message ?? e).slice(0, 300)}。请确认已安装并登录 Amazon Quick 桌面版。`,
              }
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.type === 'api' ? auth.key : undefined
        if (!key) return {}
        return { baseURL: BASE, apiKey: 'aws-quick-local', fetch: makeFetch(outpostMgr, { ...opts, identityKey: key }, sessions) }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api' || !auth.key) return provider.models
        const out = {}
        for (const m of MODELS) out[m.id] = structuredClone(BASE_MODEL)
        return out
      },
    },
  }
}

// Test surface (not a plugin function; the host calls every exported function).
export const _internal = { makeFetch, makeSessions, PROVIDER, BASE, MODELS }
