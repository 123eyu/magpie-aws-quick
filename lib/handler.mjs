// Serve one OpenAI Chat Completions request through an Amazon Quick chat turn.
//
// Quick has no OpenAI-shaped HTTP API: the desktop client talks to a bidi
// WebSocket (`session_connect` → `user_message` → text_delta/thinking_delta/…
// → turn_completed). This module renders the OpenAI message list into Quick's
// text protocol, runs the turn on a cached thread, and re-emits the event
// stream as chat.completion / chat.completion.chunk.
import { QuickSocket, QuickWsError } from './quickws.mjs'
import { OutpostError } from './outpost.mjs'
import {
  AGENT_MODES, MODELS, modeFor, effortFor, renderTranscript, renderDelta, textOf,
} from './translate.mjs'
import {
  chainHashes, sessionScope, findContinuation, extendHash, replyMessage,
} from './sessions.mjs'

const SURFACE = 'QUICK_WORK_DESKTOP_WINDOWS'
const APP_VERSION = '1.2.4660'

function errorResponse(status, message, type = 'api_error') {
  return new Response(JSON.stringify({ error: { message, type, code: status } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorType(err) {
  if (err?.kind === 'auth') return 'authentication_error'
  if (err?.status === 429 || err?.kind === 'quota') return 'rate_limit_error'
  return 'api_error'
}

function httpStatus(err) {
  if (err instanceof OutpostError || err instanceof QuickWsError) {
    if (err.kind === 'auth') return 401
    if (err.kind === 'abort') return 499
    if (err.kind === 'spawn' || err.kind === 'timeout') return 503
  }
  return err?.status && err.status >= 400 && err.status < 600 ? err.status : 502
}

const sockets = new WeakMap() // Outpost → QuickSocket

async function socketFor(outpost, options) {
  let s = sockets.get(outpost)
  if (!s) {
    const outpostId = await outpost.outpostId()
    if (!outpostId) throw new OutpostError('outpost 未返回设备 id（/local/outpost-id），请确认已登录 Amazon Quick', { kind: 'auth', status: 401 })
    s = new QuickSocket({
      getSession: () => outpost.session(),
      outpostId,
      extra: {
        surfaceType: options?.surfaceType || SURFACE,
        appVersion: options?.appVersion || APP_VERSION,
        channel: options?.channel,
      },
      log: options?.log,
    })
    sockets.set(outpost, s)
  }
  return s
}

/** Usage object from a turn_usage event payload (snake_case wire fields). */
function usageFrom(u) {
  if (!u || typeof u !== 'object') return null
  const input = Number(u.input_tokens ?? u.inputTokens) || 0
  const cached = Number(u.cache_read_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens) || 0
  const written = Number(u.cache_write_tokens ?? u.cacheWriteTokens) || 0
  const completion = Number(u.output_tokens ?? u.outputTokens) || 0
  // Quick reports non-cached input, cache reads and cache writes separately;
  // OpenAI prompt_tokens is the whole prompt side.
  const prompt = input + cached + written
  const total = Number(u.total_tokens ?? u.totalTokens) || prompt + completion
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  }
}

function addUsage(acc, u) {
  if (!u) return acc
  acc = acc ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  acc.prompt_tokens += u.prompt_tokens || 0
  acc.completion_tokens += u.completion_tokens || 0
  acc.total_tokens += u.total_tokens || 0
  if (u.prompt_tokens_details?.cached_tokens) {
    acc.prompt_tokens_details = acc.prompt_tokens_details ?? { cached_tokens: 0 }
    acc.prompt_tokens_details.cached_tokens += u.prompt_tokens_details.cached_tokens
  }
  return acc
}

/**
 * Normalized turn output:
 *   {type:'meta', threadId, reused}     once, before stream events
 *   {type:'text', text}                 visible answer delta
 *   {type:'reasoning', text}            thinking_delta
 *   {type:'usage', usage}               turn_usage (per message)
 *   {type:'note', text}                 non-fatal oddities worth showing
 */
async function* runTurn({ outpost, socket, body, sessions, options, signal }) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const convo = messages.filter((m) => m.role !== 'system' && m.role !== 'developer')
  const systemText = messages
    .filter((m) => m.role === 'system' || m.role === 'developer')
    .map((m) => textOf(m.content))
    .join('\n\n')
  const mode = modeFor(body.model)
  const effort = effortFor(options?.effortHeader, body)

  // Tool schemas can't cross the WS protocol; Quick runs its own agent tools.
  // Identity still covers them so switching tools doesn't reuse stale threads.
  const identity = options?.identity || 'local'
  const hashes = chainHashes(sessionScope(identity, `${mode}|${effort ?? ''}`, systemText, body.tools), convo)
  const cont = sessions ? findContinuation(sessions, hashes, convo) : undefined

  let threadId
  let text
  let reused = false
  if (cont) {
    threadId = cont.entry.threadId
    text = renderDelta(cont.delta)
    reused = true
  } else {
    threadId = crypto.randomUUID()
    text = renderTranscript(convo, systemText)
  }
  if (!text.trim()) text = '(empty)'

  const state = { text: '', reasoning: '', usage: null }
  yield { type: 'meta', threadId, reused, mode }

  const payload = {
    text,
    message_id: crypto.randomUUID(),
    agent_mode: mode,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    user_locale: (Intl.DateTimeFormat().resolvedOptions().locale || 'en-US').replace('_', '-'),
  }
  if (effort) payload.thinking_effort = effort
  if (options?.chatAgentId) payload.chat_agent_id = options.chatAgentId
  if (body.temperature != null) payload.temperature = body.temperature // ignored server-side; harmless if dropped

  let produced = false
  try {
    for await (const evt of socket.turn(threadId, payload, { signal })) {
      const t = evt.type
      const p = evt.payload || {}
      if (t === 'text_delta' && typeof p.delta === 'string') {
        produced = true
        state.text += p.delta
        yield { type: 'text', text: p.delta }
      } else if (t === 'thinking_delta' && typeof p.delta === 'string') {
        produced = true
        state.reasoning += p.delta
        yield { type: 'reasoning', text: p.delta }
      } else if (t === 'turn_usage') {
        const u = usageFrom(p)
        if (u) { state.usage = addUsage(state.usage, u); yield { type: 'usage', usage: u } }
      } else if (t === 'message_complete') {
        // Fallback: deltas can be dropped; the complete payload carries full text.
        if (!produced && typeof p.text === 'string' && p.text) {
          state.text = p.text
          yield { type: 'text', text: p.text }
        }
      } else if (t === 'message_start' || t === 'connected' || t === 'session_established' || t === 'keepalive') {
        // noise
      } else if (t === 'status') {
        const s = p.status || p.message
        if (s && !/pong|ok/i.test(String(s))) yield { type: 'note', text: `[quick] ${s}` }
      } else if (t === 'guardrail_blocked' || t === 'error') {
        throw new QuickWsError(p.message || p.reason || p.error || `quick ${t}`, { kind: 'stream' })
      }
      // tool_start/tool_arguments/tool_progress/tool_result, runs_updated,
      // task_list_update, title_generated, session_sync … are agent-internal;
      // Quick executes its own tools, so they don't map to OpenAI tool_calls.
    }
  } catch (e) {
    if (!produced && cont && sessions) {
      // Cached thread may be gone server-side: retry once on a fresh thread with
      // the full transcript (same policy as magpie-comate).
      const fresh = crypto.randomUUID()
      const full = renderTranscript(convo, systemText)
      yield { type: 'meta', threadId: fresh, reused: false, mode }
      state.text = ''
      state.reasoning = ''
      state.usage = null
      const payload2 = { ...payload, text: full || '(empty)', message_id: crypto.randomUUID() }
      for await (const evt of socket.turn(fresh, payload2, { signal })) {
        const t = evt.type
        const p = evt.payload || {}
        if (t === 'text_delta' && typeof p.delta === 'string') {
          state.text += p.delta
          yield { type: 'text', text: p.delta }
        } else if (t === 'thinking_delta' && typeof p.delta === 'string') {
          state.reasoning += p.delta
          yield { type: 'reasoning', text: p.delta }
        } else if (t === 'turn_usage') {
          const u = usageFrom(p)
          if (u) { state.usage = addUsage(state.usage, u); yield { type: 'usage', usage: u } }
        } else if (t === 'message_complete' && !state.text && typeof p.text === 'string' && p.text) {
          state.text = p.text
          yield { type: 'text', text: p.text }
        } else if (t === 'guardrail_blocked' || t === 'error') {
          throw new QuickWsError(p.message || p.reason || p.error || `quick ${t}`, { kind: 'stream' })
        }
      }
      threadId = fresh
    } else {
      throw e
    }
  }

  // Remember where this conversation stands for the next request.
  if (sessions && state.text) {
    const key = extendHash(hashes[convo.length], replyMessage(state.text))
    sessions.set(key, { threadId })
  }
  yield { type: 'done', threadId, text: state.text, reasoning: state.reasoning, usage: state.usage }
}

function makeId(threadId) {
  return `chatcmpl-quick-${threadId?.slice(0, 8) ?? 'x'}-${Date.now().toString(36)}`
}

/**
 * @param {object} p
 * @param {object} p.body       parsed Chat Completions request
 * @param {object} p.outpostMgr createOutpostManager() result
 * @param {object} [p.sessions] session store (lib/sessions.mjs)
 * @param {object} [p.options]  plugin options
 * @param {string} [p.effortHeader] X-Magpie-Effort style header value
 * @param {AbortSignal} [p.signal]
 */
export async function handleChatCompletions({ body, outpostMgr, sessions, options, effortHeader, signal }) {
  if (!body || typeof body !== 'object') return errorResponse(400, 'request body must be JSON', 'invalid_request_error')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return errorResponse(400, 'messages is required', 'invalid_request_error')
  }
  let outpost
  try {
    outpost = await outpostMgr.ensure()
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  let socket
  try {
    socket = await socketFor(outpost, { ...options, effortHeader, log: options?.log })
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }

  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'smart'
  const it = runTurn({ outpost, socket, body: { ...body, model }, sessions, options: { ...options, effortHeader }, signal })

  // Pull up to the first real output before answering so auth/session failures
  // surface as real HTTP statuses (magpie marks the account on 401, fails over
  // on 429/5xx) instead of a 200 stream that dies immediately.
  const pre = []
  let done = false
  let meta
  try {
    for (;;) {
      const r = await it.next()
      if (r.done) { done = true; break }
      if (r.value.type === 'meta') { meta = r.value; continue }
      if (r.value.type === 'note') continue // notes ride inside the stream
      pre.push(r.value)
      break
    }
  } catch (e) {
    return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
  }
  const items = (async function* () {
    yield* pre
    if (done) return
    for (;;) {
      const r = await it.next()
      if (r.done) return
      yield r.value
    }
  })()

  const created = Math.floor(Date.now() / 1000)
  const id = makeId(meta?.threadId)

  if (!body.stream) {
    let text = ''
    let reasoning = ''
    let usage
    try {
      for await (const o of items) {
        if (o.type === 'text') text += o.text
        else if (o.type === 'reasoning') reasoning += o.text
        else if (o.type === 'usage') usage = addUsage(usage, o.usage)
      }
    } catch (e) {
      return errorResponse(httpStatus(e), e?.message ?? String(e), errorType(e))
    }
    const message = { role: 'assistant', content: text }
    if (reasoning) message.reasoning_content = reasoning
    return new Response(
      JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  const enc = new TextEncoder()
  const includeUsage = !!body.stream_options?.include_usage
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
      const chunk = (delta, finish = null) => send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })
      let sentRole = false
      const role = () => {
        if (!sentRole) {
          sentRole = true
          chunk({ role: 'assistant', content: '' })
        }
      }
      let usage
      try {
        for await (const o of items) {
          if (o.type === 'text') {
            role()
            chunk({ content: o.text })
          } else if (o.type === 'reasoning') {
            role()
            chunk({ reasoning_content: o.text })
          } else if (o.type === 'usage') usage = addUsage(usage, o.usage)
          else if (o.type === 'note') {
            role()
            chunk({ content: `\n\n> ${o.text}` })
          }
        }
        role()
        chunk({}, 'stop')
        if (includeUsage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } catch (e) {
        send({ error: { message: e?.message ?? String(e), type: errorType(e), code: httpStatus(e) } })
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
      } finally {
        controller.close()
      }
    },
    cancel() {
      items.return?.()
      it.return?.()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** /v1/models in OpenAI shape. */
export function handleModels() {
  return new Response(JSON.stringify({ object: 'list', data: MODELS }), {
    headers: { 'content-type': 'application/json' },
  })
}

export { AGENT_MODES }
