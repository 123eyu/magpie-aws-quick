import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textOf, modeFor, effortFor, renderTranscript, renderDelta, byteLen, capText, UPSTREAM_TEXT_LIMIT, imagesOf, pickImages } from '../lib/translate.mjs'

test('textOf handles strings, parts arrays, and junk', () => {
  assert.equal(textOf('hi'), 'hi')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textOf(null), '')
  assert.equal(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '[image]')
  assert.equal(textOf(42), '42')
})

test('textOf understands Anthropic/Responses-style content parts', () => {
  // Responses API spellings
  assert.equal(textOf([{ type: 'input_text', text: 'hello' }]), 'hello')
  assert.equal(textOf([{ type: 'output_text', text: 'world' }]), 'world')
  // Anthropic tool blocks inside content arrays
  assert.equal(textOf([{ type: 'tool_result', content: 'tool output' }]), 'tool output')
  assert.equal(
    textOf([{ type: 'tool_result', content: [{ type: 'text', text: 'nested' }] }]),
    'nested',
  )
  assert.equal(
    textOf([{ type: 'tool_use', name: 'Read', input: { path: '/a' } }]),
    '[called tool Read({"path":"/a"})]',
  )
  // reasoning blocks contribute nothing
  assert.equal(
    textOf([{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }]),
    'answer',
  )
})

test('modeFor maps model ids to agent modes', () => {
  assert.equal(modeFor('fast'), 'fast')
  assert.equal(modeFor('balanced'), 'balanced')
  assert.equal(modeFor('smart'), 'smart')
  assert.equal(modeFor('advanced'), 'advanced')
  assert.equal(modeFor('provider/fast'), 'fast')
  assert.equal(modeFor('AWS Quick Smart'), 'smart')
  assert.equal(modeFor('gpt-5'), 'smart') // unknown → default
  assert.equal(modeFor(undefined), 'smart')
  assert.equal(modeFor(''), 'smart')
})

test('effortFor maps header/body spellings to quick levels', () => {
  assert.equal(effortFor('high', {}), 'high')
  assert.equal(effortFor(undefined, { reasoning_effort: 'low' }), 'low')
  assert.equal(effortFor(undefined, { thinking_effort: 'max' }), 'max')
  assert.equal(effortFor('xhigh', {}), 'max')
  assert.equal(effortFor('none', {}), 'off')
  assert.equal(effortFor('bogus', {}), undefined)
  assert.equal(effortFor(undefined, {}), undefined)
})

test('renderTranscript: system + history + raw final user turn', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'reply one' },
    { role: 'user', content: 'second' },
  ]
  const out = renderTranscript(messages, 'be terse')
  assert.ok(out.includes('[system instructions]\nbe terse'))
  assert.ok(out.includes('[conversation so far]'))
  assert.ok(out.includes('user: first'))
  assert.ok(out.includes('assistant: reply one'))
  // last user message goes in raw, no role prefix
  assert.ok(out.endsWith('\n\nsecond'))
  assert.ok(!out.includes('user: second'))
})

test('renderTranscript without system/history is just the user text', () => {
  assert.equal(renderTranscript([{ role: 'user', content: 'hello' }], ''), 'hello')
})

test('renderDelta renders only new user/tool content', () => {
  const delta = [
    { role: 'user', content: 'next question' },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'file body' },
  ]
  const out = renderDelta(delta)
  assert.ok(out.includes('next question'))
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('file body'))
})

test('capText truncates by bytes with marker and respects budget', () => {
  const s = 'x'.repeat(10 * 1024)
  const out = capText(s, 4096)
  assert.ok(byteLen(out) <= 4096)
  assert.ok(out.endsWith('[truncated]'))
  assert.equal(capText('short', 4096), 'short')
  // multi-byte chars: byte budget must hold even for CJK
  const cjk = capText('汉'.repeat(5000), 4096)
  assert.ok(byteLen(cjk) <= 4096)
  assert.ok(cjk.includes('truncated'))
})

test('renderTranscript drops oldest history first, keeps final user turn', () => {
  const messages = [
    { role: 'user', content: 'OLD-QUESTION-' + 'a'.repeat(3000) },
    { role: 'assistant', content: 'OLD-ANSWER-' + 'b'.repeat(3000) },
    { role: 'user', content: 'RECENT-' + 'c'.repeat(2000) },
    { role: 'assistant', content: 'RECENT-ANSWER-' + 'd'.repeat(2000) },
    { role: 'user', content: 'FINAL-QUESTION' },
  ]
  const stats = {}
  const out = renderTranscript(messages, 'sys', { maxBytes: 8000, stats })
  assert.ok(stats.truncated)
  assert.ok(out.endsWith('FINAL-QUESTION')) // current turn never dropped
  assert.ok(!out.includes('OLD-QUESTION')) // oldest dropped
  assert.ok(out.includes('RECENT-QUESTION') || out.includes('RECENT-ANSWER') || out.includes('recent'))
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(byteLen(out) <= 8000)
})

test('renderTranscript caps oversized system prompt and user turn', () => {
  const messages = [{ role: 'user', content: 'u'.repeat(30 * 1024) }]
  const stats = {}
  const out = renderTranscript(messages, 's'.repeat(40 * 1024), { maxBytes: UPSTREAM_TEXT_LIMIT, stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[truncated]'))
  assert.ok(byteLen(out) <= UPSTREAM_TEXT_LIMIT)
  assert.ok(out.endsWith('[truncated]')) // user turn itself was capped
})

test('renderDelta caps oversized tool results per block', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'F'.repeat(30 * 1024) },
    { role: 'user', content: 'next' },
  ]
  const stats = {}
  const out = renderDelta(delta, { stats })
  assert.ok(stats.truncated)
  assert.ok(out.includes('[tool_result read c1]'))
  assert.ok(out.includes('next'))
  assert.ok(byteLen(out) < 20 * 1024) // 16KB cap + small user msg
})

test('renderDelta shares the budget across parallel tool results instead of dropping the oldest', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'a', content: 'A'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c2', name: 'b', content: 'B'.repeat(10 * 1024) },
    { role: 'tool', tool_call_id: 'c3', name: 'c', content: 'C'.repeat(10 * 1024) },
    { role: 'user', content: 'final question' },
  ]
  const stats = {}
  const out = renderDelta(delta, { maxBytes: 20 * 1024, stats })
  assert.ok(stats.truncated)
  assert.ok(byteLen(out) <= 20 * 1024)
  assert.ok(out.endsWith('final question'))
  for (const h of ['[tool_result a c1]', '[tool_result b c2]', '[tool_result c c3]']) assert.ok(out.includes(h), h)
  assert.ok(!out.includes('earlier message(s) omitted'))
  assert.equal((out.match(/middle omitted/g) || []).length, 3)
})

test('renderDelta keeps small results whole and squeezes only the large one', () => {
  const delta = [
    { role: 'tool', tool_call_id: 'c1', name: 'small', content: 'tiny output' },
    { role: 'tool', tool_call_id: 'c2', name: 'big', content: 'HEAD' + 'x'.repeat(40 * 1024) + 'TAIL-ERROR' },
  ]
  const out = renderDelta(delta, { maxBytes: 8 * 1024 })
  assert.ok(byteLen(out) <= 8 * 1024)
  assert.ok(out.includes('tiny output'))
  assert.ok(out.includes('HEAD') && out.includes('TAIL-ERROR')) // head + tail both survive
  assert.ok(out.includes('re-run the tool'))
})

test('renderDelta still drops oldest text when conversation text alone overflows', () => {
  const delta = [
    { role: 'user', content: 'OLD-' + 'a'.repeat(6000) },
    { role: 'user', content: 'NEW-QUESTION' },
  ]
  const out = renderDelta(delta, { maxBytes: 4096 })
  assert.ok(byteLen(out) <= 4096)
  assert.ok(!out.includes('OLD-'))
  assert.ok(out.includes('earlier message(s) omitted'))
  assert.ok(out.endsWith('NEW-QUESTION'))
})

test('renderTranscript squeezes stale tool results, keeps fresh ones and all dialogue', () => {
  const messages = [
    { role: 'user', content: 'FIRST-ASK' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'STALE' + 's'.repeat(12 * 1024) },
    { role: 'assistant', content: 'MIDDLE-ANSWER', tool_calls: [{ id: 'c2', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'read', content: 'FRESH' + 'f'.repeat(8 * 1024) },
  ]
  const out = renderTranscript(messages, '', { maxBytes: UPSTREAM_TEXT_LIMIT })
  assert.ok(out.includes('FIRST-ASK') && out.includes('MIDDLE-ANSWER'))
  assert.ok(out.includes('STALE') && out.includes('middle omitted')) // stale result squeezed, not dropped
  assert.ok(out.includes('f'.repeat(8 * 1024))) // fresh result fits whole
  assert.ok(byteLen(out) < 16 * 1024)
})

test('imagesOf reads OpenAI, Responses, Anthropic and nested tool_result image shapes', () => {
  const imgs = imagesOf([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,REVG' },
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'R0hJ' } },
    { type: 'tool_result', content: [{ type: 'image_url', image_url: { url: 'data:image/gif;base64,SktM' } }] },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'text', text: 'not an image' },
  ])
  assert.deepEqual(imgs.slice(0, 4).map((i) => i.mimeType), ['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
  assert.equal(imgs[0].data, 'QUJD')
  assert.deepEqual(imgs[4], { url: 'https://example.com/a.png' })
  assert.equal(imgs.length, 5)
})

test('pickImages keeps images that fit the byte budget and counts the rest as skipped', () => {
  const small = 'A'.repeat(1000)
  const big = 'B'.repeat(50 * 1024)
  const msgs = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${big}` } }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${small}` } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] },
  ]
  const r = pickImages(msgs, 10 * 1024)
  assert.equal(r.attachments.length, 1)
  assert.deepEqual(r.attachments[0], { type: 'image', name: 'image-1.jpg', size: 750, mimeType: 'image/jpeg', data: small })
  assert.equal(r.skipped, 2)
  assert.ok(r.bytes >= small.length && r.bytes <= 10 * 1024)
})
