// OpenAI tools ⇄ Quick text convention.
//
// Quick's bidi protocol has no client-tool channel: its agent runtime owns the
// tool loop and executes ITS tools server-side (verified live — tool_start/
// tool_arguments/tool_result events, message_complete.tool_calls stays empty).
// But the underlying model will happily emit a caller-defined convention as
// plain text when the instruction is strong and inline (verified: a MANDATORY
// block in the user text produced exactly `<tool_call>{json}</tool_call>`).
//
// So we inject tool specs + rules into the message text, parse
// <tool_call>{"name":…,"arguments":{…}}</tool_call> blocks out of the streamed
// text, and surface them as OpenAI tool_calls. Results come back as role:'tool'
// messages, rendered into the next turn's text by renderDelta.

/** OpenAI tools[] → compact spec list (function tools only). */
export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn || typeof fn.name !== 'string' || !fn.name) continue
    // OpenAI uses `parameters`; Anthropic-style shims may send `input_schema`.
    const schema = fn.parameters ?? fn.input_schema
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} },
    })
  }
  return out
}

function toolSpecLine(t) {
  const params = JSON.stringify(t.parameters)
  return `- ${t.name}: ${t.description || '(no description)'}\n  parameters: ${params}`
}

/**
 * The instruction block prepended to the text we send upstream.
 * @param {Array} tools normalized tools (may be empty → returns '')
 * @param {string|object} [toolChoice] body.tool_choice
 */
export function buildToolPreamble(tools, toolChoice) {
  if (!tools.length) return ''
  // OpenAI: 'auto'|'required'|'none'|{type:'function',function:{name}}
  // Anthropic-style shims: {type:'auto'|'any'|'none'|'tool', name?}
  const tc = typeof toolChoice === 'object' && toolChoice !== null ? toolChoice : null
  const openAiName = tc?.function?.name
  const anthropicName = tc?.type === 'tool' ? tc.name : undefined
  const forced = openAiName ?? anthropicName
    ?? (toolChoice === 'required' || tc?.type === 'any' ? true : false)
  const only = typeof forced === 'string' ? tools.filter((t) => t.name === forced) : tools
  const specs = (only.length ? only : tools).map(toolSpecLine).join('\n')
  const must = forced
    ? only.length === 1 && typeof forced === 'string'
      ? `This request requires the client tool "${forced}" — reply with only its <tool_call> block.`
      : 'This request requires a client tool — reply with <tool_call> block(s) only.'
    : ''
  return [
    '[Client tool calling]',
    'The application you are assisting exposes the tools below; it executes them on the user\'s machine and returns each result as a [tool_result …] message.',
    'When the task needs one of them, reply with ONLY a block in this format (no other text):',
    '<tool_call>{"name":"<tool_name>","arguments":{<json arguments>}}</tool_call>',
    'Guidelines:',
    '- one block per call; several blocks are allowed for parallel calls;',
    '- "arguments" is a JSON object matching the parameters schema;',
    '- after a [tool_result …] message arrives, continue the task in plain text;',
    must,
    'Tools provided by the client:',
    specs,
  ].filter(Boolean).join('\n')
}

const OPEN_TAG = '<tool_call>'
const CLOSE_TAG = '</tool_call>'
const OPEN_RE = /<tool_call>/g
const CLOSE_RE = /<\/tool_call>/g

/** Longest suffix of `buf` that is a proper prefix of `tag` (0 if none). */
function heldPrefixLen(buf, tag) {
  const max = Math.min(buf.length, tag.length - 1)
  for (let k = max; k >= 1; k--) {
    if (buf.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/**
 * Incremental parser: feed text_delta strings, get back visible text and
 * completed tool calls. Blocks split across deltas are handled — including a
 * tag split mid-token (`<` + `tool_call>…`), which is held back rather than
 * flushed. A dangling <tool_call> at end() is reported via `dropped`.
 */
export function createToolCallParser() {
  let buf = ''
  let inBlock = false
  let blockJson = ''
  let dropped = false
  const pending = [] // parsed calls waiting for id assignment

  const drain = () => {
    const text = []
    const calls = []
    for (;;) {
      if (!inBlock) {
        OPEN_RE.lastIndex = 0
        const m = OPEN_RE.exec(buf)
        if (!m) {
          // Hold back a suffix that could be the start of <tool_call>.
          const hold = heldPrefixLen(buf, OPEN_TAG)
          text.push(buf.slice(0, buf.length - hold))
          buf = buf.slice(buf.length - hold)
          break
        }
        text.push(buf.slice(0, m.index))
        buf = buf.slice(m.index + m[0].length)
        inBlock = true
        blockJson = ''
        continue
      }
      CLOSE_RE.lastIndex = 0
      const m = CLOSE_RE.exec(buf)
      if (!m) {
        // Same holdback for a split </tool_call> — keep it out of blockJson.
        const hold = heldPrefixLen(buf, CLOSE_TAG)
        blockJson += buf.slice(0, buf.length - hold)
        buf = buf.slice(buf.length - hold)
        break
      }
      blockJson += buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      inBlock = false
      const call = parseCall(blockJson)
      if (call) calls.push(call)
      else dropped = true
      blockJson = ''
    }
    return { text: text.join(''), calls }
  }

  return {
    /** Feed a delta; returns {text, calls:[{name, arguments(object)}]}. */
    push(delta) {
      if (!delta) return { text: '', calls: [] }
      buf += delta
      const r = drain()
      for (const c of r.calls) pending.push(c)
      return { text: r.text, calls: r.calls }
    },
    /** Flush at stream end. Returns {text, calls, dropped}. */
    end() {
      const r = drain()
      for (const c of r.calls) pending.push(c)
      let tail = r.text
      if (inBlock) {
        // unterminated block → not shown to the user
        dropped = true
        inBlock = false
        blockJson = ''
        buf = ''
      } else if (buf) {
        // held-back tag prefix at EOS is just literal text
        tail += buf
        buf = ''
      }
      return { text: tail, calls: r.calls, dropped: dropped || undefined }
    },
    /** All calls seen so far (for session bookkeeping). */
    get calls() { return pending },
  }
}

function parseCall(json) {
  let obj
  try { obj = JSON.parse(json.trim()) } catch { return null }
  const name = obj?.name ?? obj?.tool ?? obj?.function?.name
  if (typeof name !== 'string' || !name) return null
  let args = obj.arguments ?? obj.args ?? obj.input ?? obj.parameters ?? {}
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { /* keep string */ }
  }
  if (args == null || typeof args !== 'object') args = {}
  return { name, arguments: args }
}

/** Assign OpenAI-style ids to parsed calls: call_<rand>. */
export function withCallIds(calls) {
  return calls.map((c) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }))
}
