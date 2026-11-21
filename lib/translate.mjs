// OpenAI ⇄ Quick message rendering + model/mode mapping.
//
// Quick's user_message carries a single `text` field — there is no system
// prompt channel we could verify (custom_prompt / project_context.instructions
// were ignored in testing), so the client's system prompt and history are
// rendered into the text itself, the same approach magpie-comate takes.

/** Text content of an OpenAI message (string or parts array). */
export function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p
        if (p?.type === 'text') return p.text ?? ''
        if (p?.type === 'image_url' || p?.type === 'input_image') return '[image omitted]'
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
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

/** One transcript line for a non-user message in the rendered history. */
function transcriptLine(m) {
  const text = textOf(m.content)
  if (m.role === 'assistant') {
    const calls = renderToolCalls(m.tool_calls)
    return `assistant: ${[text, calls].filter(Boolean).join('\n')}`
  }
  if (m.role === 'tool' || m.role === 'function') {
    return `[tool_result ${m.name || m.tool_call_id || ''}]\n${text}`
  }
  return `${m.role}: ${text}`
}

/**
 * Full-transcript text for a NEW thread: system prompt + rendered history +
 * the final user turn. Everything the model needs in one user_message.
 */
export function renderTranscript(messages, systemText) {
  const parts = []
  if (systemText) parts.push(`[system instructions]\n${systemText}`)
  const lines = messages.map(transcriptLine).filter(Boolean)
  if (lines.length > 1) parts.push(`[conversation so far]\n${lines.slice(0, -1).join('\n\n')}`)
  // The final user turn goes in raw — same shape renderDelta uses on reused
  // threads, so the model sees one consistent format for new input.
  const lastMsg = messages[messages.length - 1]
  const last = lastMsg?.role === 'user' ? textOf(lastMsg.content) : lines[lines.length - 1] ?? ''
  parts.push(last || '(empty)')
  return parts.join('\n\n')
}

/** Delta text for a REUSED thread: only the new user/tool content. */
export function renderDelta(delta) {
  const blocks = []
  for (const m of delta) {
    const text = textOf(m.content)
    if (m.role === 'tool' || m.role === 'function') {
      blocks.push(`[tool_result ${m.name || m.tool_call_id || ''}]\n${text}`)
    } else if (m.role === 'user') {
      if (text) blocks.push(text)
    }
    // assistant messages never appear in a valid delta (findContinuation rejects them)
  }
  return blocks.join('\n\n')
}
