import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AwsQuickAuthPlugin } from '../index.mjs'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'plugin-test-'))

test('auth.methods: two browser-OAuth methods + the local-credentials api method', async () => {
  const dir = tmp()
  try {
    const plugin = await AwsQuickAuthPlugin(null, { sessionDir: dir, log: () => {} })
    const methods = plugin.auth.methods
    assert.equal(methods.length, 3)
    assert.equal(methods[0].type, 'oauth')
    assert.equal(methods[1].type, 'oauth')
    assert.equal(methods[2].type, 'api')
    assert.equal(methods[2].keyless, true)
    assert.match(methods[2].labels?.zh ?? methods[2].label, /本地凭据/)

    // method 1 (copy sign-in link): magpie must not auto-open a browser
    const ac1 = new AbortController()
    const r1 = await methods[1].authorize(undefined, { signal: ac1.signal })
    assert.equal(r1.opened, true)
    assert.equal(r1.method, 'auto')
    assert.ok(r1.url.includes('qwSurface='), `sign-in url: ${r1.url}`)
    assert.equal(typeof r1.callback, 'function')
    assert.ok(r1.instructions)

    // method 0 (browser OAuth): no opened flag, magpie opens the browser itself
    const ac0 = new AbortController()
    const r0 = await methods[0].authorize(undefined, { signal: ac0.signal })
    assert.notEqual(r0.opened, true)
    assert.equal(r0.method, 'auto')
    assert.ok(r0.url.includes('qwSurface='), `sign-in url: ${r0.url}`)
    assert.equal(typeof r0.callback, 'function')

    // aborting the sign-in signal cancels the wait; callback reports it
    ac1.abort()
    const c1 = await r1.callback(undefined, { signal: ac1.signal })
    assert.equal(c1.type, 'failed')
    assert.equal(c1.error, '登录已取消')
    ac0.abort()
    const c0 = await r0.callback(undefined, { signal: ac0.signal })
    assert.equal(c0.type, 'failed')
    assert.equal(c0.error, '登录已取消')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
