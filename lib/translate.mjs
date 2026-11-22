// OpenAI ⇄ Quick message rendering + model/mode mapping.
//
// Quick's user_message carries a single `text` field for the conversation;
// the client's system prompt goes through the dedicated
// `user_message.payload.system_prompt` field instead (verified live — the
// server honors it as a per-turn system override). History and tool results
// are still rendered into the text itself, the same approach magpie-comate
// takes.

/** Text content of one content-part object (OpenAI/Anthropic/Responses shapes). */
function partText(p) {
  if (typeof p === 'string') return p
  const t = p?.type
  if (t === 'text' || t === 'input_text' || t === 'output_text') return p.text ?? ''
  if (t === 'image_url' || t === 'input_image' || t === 'image') return '[image omitted]'
  if (t === 'file' || t === 'input_file') return '[file omitted]'
  if (t === 'tool_result') return textOf(p.content) // string or nested parts
  if (t === 'tool_use') {
    const args = typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {})
    return `[called tool ${p.name ?? 'tool'}(${args})]`
  }
  return '' // thinking/redacted_thinking/audio/etc carry no user-visible text
}

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n')
  }
  return String(content)
}

/**
 * Canonical role across client dialects: some agents/gateways emit 'ai',
 * 'human', 'observation' etc. instead of the OpenAI names. Thread-reuse
 * prefix matching and transcript rendering both key off this.
 */
export function canonRole(role) {
  const r = String(role ?? '').toLowerCase()
  if (r === 'assistant' || r === 'ai' || r === 'bot' || r === 'model' || r === 'assistant_message') return 'assistant'
  if (r === 'user' || r === 'human' || r === 'input') return 'user'
  if (r === 'tool' || r === 'tool_result' || r === 'observation' || r === 'tool_output') return 'tool'
  return r
}

/** Agent modes the desktop client can send as `agent_mode`. */
export const AGENT_MODES = Object.freeze(['fast', 'balanced', 'smart', 'advanced'])

export const MODELS = Object.freeze(
  AGENT_MODES.map((mode) => ({
    id: mode,
    object: 'model',
    created: 0,
    owned_by: 'aws-quick',
    name: { fast: 'Quick Fast', balanced: 'Quick Balanced', smart: 'Quick Smart', advanced: 'Quick Advanced' }[mode],
  })),
)

/** Map a requested model id to an agent_mode; unknown → 'smart'. */
export function modeFor(model) {
  const m = String(model ?? '').trim().toLowerCase()
  const bare = m.includes('/') ? m.split('/').pop() : m
  return AGENT_MODES.includes(bare) ? bare : 'smart'
}

/** thinking_effort levels the client understands (off/low/medium/high/max). */
export const EFFORT_LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])

/**
 * thinking_effort from the X-Magpie-Effort header or body.reasoning_effort.
 * Returns undefined when unset/invalid (server then uses its default).
 */
export function effortFor(effortHeader, body) {
  const raw = effortHeader ?? body?.reasoning_effort ?? body?.thinking_effort
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (EFFORT_LEVELS.includes(v)) return v
  // magpie/OpenAI spellings → quick levels
  const map = { none: 'off', minimal: 'low', low: 'low', medium: 'medium', med: 'medium', high: 'high', xhigh: 'max', max: 'max' }
  return map[v] ?? (v === 'enabled' || v === 'true' ? 'high' : v === 'disabled' || v === 'false' ? 'off' : undefined)
}

function renderToolCalls(calls) {
  if (!Array.isArray(calls) || !calls.length) return ''
  return calls
    .map((c) => {
      const name = c?.function?.name ?? c?.name ?? 'tool'
      const args = c?.function?.arguments ?? c?.arguments ?? ''
      return `[called tool ${name}(${typeof args === 'string' ? args : JSON.stringify(args)})]`
    })
    .join('\n')
}

const te = new TextEncoder()
export const byteLen = (s) => te.encode(String(s ?? '')).length

/** user_message.text is hard-capped at 64 KB server-side; stay under it. */
export const UPSTREAM_TEXT_LIMIT = 60 * 1024
const SYSTEM_CAP = 24 * 1024
const USER_TURN_CAP = 20 * 1024
const TOOL_RESULT_CAP = 16 * 1024
const TRUNC_MARK = '\n…[truncated]'

function fitBytes(s, max) {
  if (byteLen(s) <= max) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLen(s.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo)
}

/** Truncate to a byte budget, appending a marker. */
export function capText(s, maxBytes) {
  const str = String(s ?? '')
  if (byteLen(str) <= maxBytes) return str
  const room = maxBytes - byteLen(TRUNC_MARK)
  if (room <= 0) return fitBytes(str, maxBytes)
  return fitBytes(str, room) + TRUNC_MARK
}

/** One transcript line for a non-user message in the rendered history. */
function transcriptLine(m) {
  const text = textOf(m.content)
  const role = canonRole(m.role)
  if (role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  if (role === 'tool' || m.role === 'function') {
    return `[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(' ')}]\n${text}`
  }
  return `${role}: ${text}`
}

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final user turn. Everything the model needs in one user_message.
 * `maxBytes` bounds the result (oldest history dropped first); `stats` is
 * mutated with {truncated:true} when anything was cut.
 */
export function renderTranscript(messages, systemText, { maxBytes = Infinity, stats } = {}) {
  const parts = []
  let used = 0
  const add = (s) => { parts.push(s); used += byteLen(s) + 2 }
  const cut = () => { if (stats) stats.truncated = true }

  if (systemText) {
    if (byteLen(systemText) > SYSTEM_CAP) { systemText = capText(systemText, SYSTEM_CAP); cut() }
    add(`[system instructions]\n${systemText}`)
  }
  const lines = messages.map(transcriptLine).filter(Boolean)
  const lastMsg = messages[messages.length - 1]
  let last = canonRole(lastMsg?.role) === 'user' ? textOf(lastMsg.content) : lines[lines.length - 1] ?? ''
  if (byteLen(last) > USER_TURN_CAP) { last = capText(last, USER_TURN_CAP); cut() }

  // History keeps the NEWEST lines that fit; the oldest are dropped first.
  const histRaw = lines.slice(0, -1)
  const lastBytes = byteLen(last || '(empty)') + 2
  const room = Math.max(0, maxBytes - used - lastBytes)
  const kept = []
  let hUsed = 0
  for (let i = histRaw.length - 1; i >= 0; i--) {
    const lb = byteLen(histRaw[i]) + 2
    if (hUsed + lb > room) { cut(); break }
    kept.unshift(histRaw[i])
    hUsed += lb
  }
  if (kept.length < histRaw.length && histRaw.length) cut()
  if (kept.length) {
    const head = kept.length < histRaw.length
      ? `[conversation so far — ${histRaw.length - kept.length} earlier message(s) omitted]\n`
      : '[conversation so far]\n'
    add(head + kept.join('\n\n'))
  }
  add(last || '(empty)')
  return parts.join('\n\n')
}

/**
 * Delta text for a REUSED thread: only the new user/tool content.
 * Per-block caps apply first (TOOL_RESULT_CAP / USER_TURN_CAP); then the
 * NEWEST blocks are kept within `maxBytes` — the current turn's question is
 * never sacrificed for older tool results.
 */
export function renderDelta(delta, { maxBytes = Infinity, stats } = {}) {
  const blocks = []
  for (const m of delta) {
    const raw = textOf(m.content)
    const role = canonRole(m.role)
    if (role === 'tool' || m.role === 'function') {
      let t = raw
      if (byteLen(t) > TOOL_RESULT_CAP) { t = capText(t, TOOL_RESULT_CAP); if (stats) stats.truncated = true }
      blocks.push(`[tool_result ${[m.name, m.tool_call_id].filter(Boolean).join(' ')}]\n${t}`)
    } else if (role === 'user') {
      if (!raw) continue
      let t = raw
      if (byteLen(t) > USER_TURN_CAP) { t = capText(t, USER_TURN_CAP); if (stats) stats.truncated = true }
      blocks.push(t)
    }
    // assistant messages never appear in a valid delta (findContinuation rejects them)
  }
  // Fit into budget keeping the newest blocks; oldest drop first.
  const kept = []
  let used = 0
  let dropped = false
  for (let i = blocks.length - 1; i >= 0; i--) {
    const bb = byteLen(blocks[i]) + 2
    if (used + bb > maxBytes) {
      dropped = true
      if (stats) stats.truncated = true
      if (kept.length === 0) {
        // The last block alone exceeds the budget — truncate it to fit.
        const room = maxBytes - byteLen(TRUNC_MARK) - 2
        if (room > 64) {
          const b = fitBytes(blocks[i], room) + TRUNC_MARK
          kept.unshift(b)
          used += byteLen(b) + 2
        }
      }
      break
    }
    kept.unshift(blocks[i])
    used += bb
  }
  if (!dropped) return kept.join('\n\n')
  const omitted = blocks.length - kept.length
  return `[${omitted} earlier message(s) omitted]\n` + kept.join('\n\n')
}
