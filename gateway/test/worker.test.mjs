/**
 * The gateway, against a fake R2 binding.
 *
 * What is worth proving here is not that R2 works. It is that the three things
 * standing between a leaked token and somebody's site behave: the token
 * comparison, the key validation that makes the prefix a boundary, and the
 * conditional writes that stop two devices overwriting each other.
 *
 * `crypto.subtle.timingSafeEqual` is a Workers extension and does not exist in
 * Node, so the tests install one. That is not a weaker test of the thing that
 * matters: the risk in that function is *how it is called*, and the stand-in
 * records every call so the tests can say so.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { comparisons, fakeBucket, installTimingSafeEqual } from './fake-r2.mjs'

installTimingSafeEqual()

const { default: worker } = await import('../src/worker.ts')

const TOKEN = 'a-token-nobody-else-has'

function call(env, method, path, { token = TOKEN, headers = {}, body } = {}) {
  const request = new Request(`https://gateway.example.workers.dev${path}`, {
    method,
    headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers },
    ...(body === undefined ? {} : { body }),
  })
  return worker.fetch(request, env)
}

const env = (bucket, extra = {}) => ({ BUCKET: bucket, TOKEN, ...extra })

// --- the token -----------------------------------------------------------

test('no token, a wrong token and a wrong scheme all get the same nothing', async () => {
  const bucket = fakeBucket({ 'current.json': '{}' })
  for (const options of [{ token: null }, { token: 'not-the-token' }, { headers: { Authorization: `Basic ${TOKEN}` }, token: null }]) {
    const response = await call(env(bucket), 'GET', '/o/current.json', options)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer')
    assert.deepEqual(await response.json(), { error: 'Unauthorized.' })
  }
})

test('a token of the wrong length is still compared, so the length does not leak through timing', async () => {
  const bucket = fakeBucket()
  comparisons.length = 0
  const response = await call(env(bucket), 'GET', '/o/current.json', { token: 'short' })
  assert.equal(response.status, 401)
  assert.equal(comparisons.length, 1, 'an early return here would answer a short guess faster than a long one')
  const [a, b] = comparisons[0]
  assert.equal(a, b, 'and the mismatched branch has to compare something of equal length: the input with itself')
})

test('a Worker deployed without its secret refuses everyone rather than everything', async () => {
  const response = await call({ BUCKET: fakeBucket(), TOKEN: '' }, 'GET', '/o/current.json', { token: '' })
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /no TOKEN set/)
})

// --- keys ----------------------------------------------------------------

/** Nothing below may reach the bucket, whichever answer it comes back with. */
function watched() {
  const bucket = fakeBucket()
  const touched = []
  for (const method of ['put', 'get', 'head', 'delete', 'list']) {
    const original = bucket[method].bind(bucket)
    bucket[method] = (...args) => {
      touched.push(method)
      return original(...args)
    }
  }
  return { bucket, touched }
}

test('a key the URL parser hands us intact, but that we should not accept, is a 400', async () => {
  const { bucket, touched } = watched()
  const cases = {
    '/absolute': '/o//absolute',
    'a nul byte': '/o/a%00b',
    'a newline': '/o/a%0Ab',
    'too long for R2': `/o/${'x'.repeat(1025)}`,
    'nothing at all': '/o/',
  }
  for (const [name, path] of Object.entries(cases)) {
    const response = await call(env(bucket), 'GET', path)
    assert.equal(response.status, 400, `${name} was not refused`)
  }
  assert.deepEqual(touched, [])
})

test('dot-segment traversal never even arrives, because the URL parser collapses it first', async () => {
  // Worth writing down rather than assuming: `/o/../secrets.json` is resolved
  // to `/secrets.json` before `new URL(request.url)` returns, so it lands
  // outside the object route entirely and is refused as an unknown path. The
  // `..` check in the Worker is the second line, and the one that does fire is
  // on the list prefix below, which rides in the query string and is not
  // normalised by anything.
  const { bucket, touched } = watched()
  for (const path of ['/o/../secrets.json', '/o/objects/../../etc/passwd', '/o/%2e%2e/escape']) {
    const response = await call(env(bucket), 'GET', path)
    assert.equal(response.status, 404, `${path} was not refused`)
  }
  assert.deepEqual(touched, [])
})

test('the prefix is enforced here, not asked for by the client', async () => {
  const bucket = fakeBucket()
  await call(env(bucket, { PREFIX: 'sites/notes' }), 'PUT', '/o/current.json', { body: '{"v":1}' })
  assert.deepEqual([...bucket.objects.keys()], ['sites/notes/current.json'])
})

// --- the round trip ------------------------------------------------------

test('put, read back, head and delete', async () => {
  const bucket = fakeBucket()
  const put = await call(env(bucket), 'PUT', '/o/objects/ab/abcd', {
    body: 'hello',
    headers: { 'Content-Type': 'text/plain' },
  })
  assert.equal(put.status, 200)
  const { etag } = await put.json()
  assert.equal(put.headers.get('ETag'), `"${etag}"`)

  const got = await call(env(bucket), 'GET', '/o/objects/ab/abcd')
  assert.equal(got.status, 200)
  assert.equal(await got.text(), 'hello')
  assert.equal(got.headers.get('ETag'), `"${etag}"`)
  assert.equal(got.headers.get('Content-Type'), 'text/plain')

  const head = await call(env(bucket), 'HEAD', '/o/objects/ab/abcd')
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('Content-Length'), '5')
  assert.equal(head.headers.get('ETag'), `"${etag}"`)

  assert.equal((await call(env(bucket), 'DELETE', '/o/objects/ab/abcd')).status, 204)
  assert.equal((await call(env(bucket), 'GET', '/o/objects/ab/abcd')).status, 404)
})

test('deleting a key that was never there is a success, exactly as it is on S3', async () => {
  assert.equal((await call(env(fakeBucket()), 'DELETE', '/o/objects/ab/gone')).status, 204)
})

test('a missing key is a 404, and says nothing else', async () => {
  const response = await call(env(fakeBucket()), 'GET', '/o/objects/ab/missing')
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'No such key.' })
})

// --- the conditional writes ----------------------------------------------

test('a stale If-Match is refused rather than overwriting', async () => {
  const bucket = fakeBucket()
  const first = await (await call(env(bucket), 'PUT', '/o/current.json', { body: '{"v":1}' })).json()
  await call(env(bucket), 'PUT', '/o/current.json', { body: '{"v":2}', headers: { 'If-Match': `"${first.etag}"` } })

  const stale = await call(env(bucket), 'PUT', '/o/current.json', {
    body: '{"v":3}',
    headers: { 'If-Match': `"${first.etag}"` },
  })
  assert.equal(stale.status, 412)
  assert.equal(bucket.objects.get('current.json').bytes.toString(), '{"v":2}', 'the refused write must not have landed')
})

test('a current If-Match goes through', async () => {
  const bucket = fakeBucket()
  const first = await (await call(env(bucket), 'PUT', '/o/current.json', { body: '{"v":1}' })).json()
  const second = await call(env(bucket), 'PUT', '/o/current.json', {
    body: '{"v":2}',
    headers: { 'If-Match': `"${first.etag}"` },
  })
  assert.equal(second.status, 200)
  assert.notEqual((await second.json()).etag, first.etag)
})

test('If-None-Match: * refuses a key that already exists', async () => {
  const bucket = fakeBucket({ 'first-publish-guard.json': '{"v":1}' })
  const response = await call(env(bucket), 'PUT', '/o/first-publish-guard.json', {
    body: '{"v":2}',
    headers: { 'If-None-Match': '*' },
  })
  assert.equal(response.status, 412)
  assert.equal(bucket.objects.get('first-publish-guard.json').bytes.toString(), '{"v":1}')
})

test('If-None-Match: * is refused by the conditional too, not only by the pre-check', async () => {
  // The pre-check exists because R2's bindings once parsed a wildcard etag as a
  // literal one. Blinding it proves the conditional is still doing the work,
  // rather than the pre-check quietly carrying a Worker that would overwrite.
  const bucket = fakeBucket({ 'first-publish-guard.json': '{"v":1}' })
  bucket.head = async () => null

  const response = await call(env(bucket), 'PUT', '/o/first-publish-guard.json', {
    body: '{"v":2}',
    headers: { 'If-None-Match': '*' },
  })
  assert.equal(response.status, 412)
  assert.equal(bucket.objects.get('first-publish-guard.json').bytes.toString(), '{"v":1}')
})

test('If-None-Match: * creates a key that is not there', async () => {
  const bucket = fakeBucket()
  const response = await call(env(bucket), 'PUT', '/o/first-publish-guard.json', {
    body: '{"v":1}',
    headers: { 'If-None-Match': '*' },
  })
  assert.equal(response.status, 200)
})

test('an unconditional write is never sent a condition', async () => {
  const bucket = fakeBucket()
  let seen
  const wrapped = { ...bucket, put: async (key, value, options) => ((seen = options), bucket.put(key, value, options)) }
  await call(env(wrapped), 'PUT', '/o/current.json', { body: '{}' })
  assert.equal(seen.onlyIf, undefined)
})

// --- listing -------------------------------------------------------------

test('list answers JSON, relative to the enforced prefix, and pages with a cursor', async () => {
  const bucket = fakeBucket({
    'sites/notes/objects/ab/one': 'a',
    'sites/notes/objects/cd/two': 'bb',
    'sites/notes/current.json': '{}',
    'somebody-elses/thing': 'x',
  })
  const withPrefix = env(bucket, { PREFIX: 'sites/notes' })

  const first = await (await call(withPrefix, 'GET', '/l?prefix=objects/')).json()
  assert.deepEqual(
    first.entries.map((e) => e.key),
    ['objects/ab/one', 'objects/cd/two'],
  )
  assert.deepEqual(first.entries[1], { key: 'objects/cd/two', size: 2, lastModified: 1000 })
  assert.equal(first.cursor, undefined)

  const everything = await (await call(withPrefix, 'GET', '/l')).json()
  assert.equal(everything.entries.length, 3, "the other prefix's objects are not this token's business")
})

test('a truncated listing hands back a cursor, and the next page continues from it', async () => {
  const bucket = fakeBucket(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`objects/${i}`, 'x'])))
  const original = bucket.list.bind(bucket)
  bucket.list = (options) => original({ ...options, limit: 2 })

  const keys = []
  let cursor
  do {
    const page = await (await call(env(bucket), 'GET', `/l?prefix=objects/${cursor ? `&cursor=${cursor}` : ''}`)).json()
    keys.push(...page.entries.map((e) => e.key))
    cursor = page.cursor
  } while (cursor)

  assert.deepEqual(keys, ['objects/0', 'objects/1', 'objects/2', 'objects/3', 'objects/4'])
})

test('a prefix that could walk out of the enforced one is refused', async () => {
  const response = await call(env(fakeBucket(), { PREFIX: 'sites/notes' }), 'GET', '/l?prefix=../')
  assert.equal(response.status, 400)
})

test('every answer is signed, so a 404 from elsewhere cannot pass for a missing key', async () => {
  const bucket = fakeBucket({ 'current.json': '{}' })
  const answers = [
    await call(env(bucket), 'GET', '/o/current.json'),
    await call(env(bucket), 'HEAD', '/o/current.json'),
    await call(env(bucket), 'PUT', '/o/current.json', { body: '{}' }),
    await call(env(bucket), 'DELETE', '/o/current.json'),
    await call(env(bucket), 'GET', '/l'),
    await call(env(bucket), 'GET', '/o/gone'),
    await call(env(bucket), 'GET', '/o//bad'),
    await call(env(bucket), 'GET', '/nowhere'),
    await call(env(bucket), 'GET', '/o/current.json', { token: 'wrong' }),
  ]
  for (const response of answers) {
    assert.equal(response.headers.get('X-Open-Publish-Gateway'), '1', `unsigned ${response.status}`)
  }
})

// --- everything else -----------------------------------------------------

test('an unknown path and an unsupported method are sentences, not silence', async () => {
  const bucket = fakeBucket()
  const unknown = await call(env(bucket), 'GET', '/admin')
  assert.equal(unknown.status, 404)
  assert.match((await unknown.json()).error, /Objects live under \/o\//)

  const method = await call(env(bucket), 'POST', '/o/current.json', { body: 'x' })
  assert.equal(method.status, 405)

  const listMethod = await call(env(bucket), 'DELETE', '/l')
  assert.equal(listMethod.status, 405)
})
