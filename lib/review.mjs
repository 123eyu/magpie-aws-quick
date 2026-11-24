// Claude Code's Auto permission reviewer asks for a decision about a quoted
// transcript. Its system policy and its evidence must both reach Quick intact.
import { byteLen, frameBytes, setInstructions, textOf, UPSTREAM_TEXT_LIMIT } from './translate.mjs'
import { QuickWsError } from './quickws.mjs'

export const REVIEW_CONTEXT = 'Review the quoted transcript using the complete application system policy. Use no tools. Return only the exact machine-readable response specified by that policy.'

const textOnly = content => typeof content === 'string' || (Array.isArray(content) && content.every(
  p => typeof p === 'string' || (['text', 'input_text', 'output_text'].includes(p?.type) && typeof p.text === 'string'),
))

export function isPermissionReview(system, messages, tools) {
  if (tools?.length || !/^You are a security monitor for autonomous AI coding agents\b/im.test(system)) return false
  if (!system.includes('<block>') && !system.includes('<severity>')) return false
  // Magpie uses the trusted system decision schema plus the tool-free user
  // transcript envelope. A quoted prompt in ordinary conversation is data.
  const startsTranscript = text => typeof text === 'string' && text.trimStart().startsWith('<transcript>')
  return messages.some(m => m.role === 'user' && (
    startsTranscript(m.content) || Array.isArray(m.content) && m.content.some(p => startsTranscript(typeof p === 'string' ? p : p?.text))
  ))
}

export function prepareReview(messages, system, base, threadId) {
  if (!messages.every(m => ['system', 'developer', 'user'].includes(m.role) && textOnly(m.content))) {
    throw Object.assign(new Error('AWS Quick permission review requires the complete policy and a text-only transcript.'), { status: 422 })
  }
  const transcript = messages.filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n\n')
  const payload = { ...base, text: transcript, web_search_enabled: false }
  setInstructions(payload, system, REVIEW_CONTEXT)
  const bytes = frameBytes(threadId, payload)
  if (bytes > UPSTREAM_TEXT_LIMIT) {
    throw Object.assign(new Error(
      'AWS Quick cannot review this action with its complete policy and transcript. '
      + 'The system instructions are ' + byteLen(system) + ' bytes and the request needs ' + bytes
      + ' bytes. The adapter budget is ' + UPSTREAM_TEXT_LIMIT + ' bytes per Quick frame. No review was requested.',
    ), { status: 413 })
  }
  return payload
}

// Buffer the answer until Quick confirms a complete, tool-free turn. Never
// derive a decision from a partial stream, a tool result or ordinary prose.
export async function readReview(socket, { threadId, payload }, signal, timeoutMs) {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
  const active = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout
  let text = '', complete = false
  const usage = []
  try {
    active?.throwIfAborted()
    for await (const { type, payload: p = {} } of socket.turn(threadId, payload, { signal: active })) {
      if (type === 'guardrail_blocked') {
        throw Object.assign(new Error('AWS Quick blocked the permission review.'), { status: 422 })
      }
      if (type.startsWith('tool_') || type === 'message_complete' && (p.continuation_expected || p.tool_calls?.length)) {
        throw Object.assign(new Error('AWS Quick attempted a tool during a text-only permission review.'), { status: 422 })
      }
      if (type === 'turn_usage') usage.push(p)
      if (type === 'text_delta') text += p.delta ?? ''
      if (type === 'message_complete') {
        text = p.text || text
        complete = true
      }
    }
    active?.throwIfAborted()
    if (!complete) throw new Error('AWS Quick ended the permission review without a complete reply.')
    return { text, usage }
  } catch (err) {
    if (active?.aborted) throw new QuickWsError('AWS Quick permission review interrupted.', { kind: signal?.aborted ? 'abort' : 'timeout' })
    throw err
  } finally {
    if (!complete || active?.aborted) socket.stop(threadId)
  }
}
