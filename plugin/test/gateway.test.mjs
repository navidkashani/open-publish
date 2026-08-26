/**
 * The gateway destination, against the same fake transport `s3.test.mjs` uses.
 *
 * The ones that matter most are the conditional writes. `publisher.ts` depends
 * on a refused write surfacing as `storage-conflict`, and on nothing else
 * surfacing that way; get it wrong and a publish is lost silently, which is the
 * failure this project cares most about.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayDestination } from '../src/destinations/gateway.ts'

const config = {
  workerUrl: 'https://open-publish-gateway.someone.workers.dev',
  token: 'a-token-nobody-else-has',
}

function recorder(responses = []) {
  const calls = []
  const client = async (request) => {
    calls.push(request)
    const next = responses.shift()
    return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '', ...(next ?? {}) }
  }
  return { client, calls }
}

const json = (body, extra = {}) => ({ status: 200, text: JSON.stringify(body), ...extra })

// --- addressing ----------------------------------------------------------

test('objects live under /o/, and nothing else is in the URL', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination(config, client).get('objects/ab/abcd')
  assert.equal(calls[0].url, 'https://open-publish-gateway.someone.workers.dev/o/objects/ab/abcd')
})

test('a key prefix lets one gateway carry several sites', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination({ ...config, prefix: '/sites/notes/' }, client).get('current.json')
  assert.equal(calls[0].url, 'https://open-publish-gateway.someone.workers.dev/o/sites/notes/current.json')
})

test('a trailing slash on the Worker address does not become a double one', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination({ ...config, workerUrl: `${config.workerUrl}/` }, client).get('current.json')
  assert.equal(calls[0].url, `${config.workerUrl}/o/current.json`)
})

test('key segments are percent-encoded, and a slash stays a separator', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination(config, client).get('objects/a b/c#d')
  assert.equal(calls[0].url, `${config.workerUrl}/o/objects/a%20b/c%23d`)
})

test('every request carries the token, and only the token', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination(config, client).get('current.json')
  assert.equal(calls[0].headers.Authorization, `Bearer ${config.token}`)
  assert.equal(calls[0].headers['x-amz-date'], undefined, 'nothing here is signed')
})

// --- reads ---------------------------------------------------------------

test('a missing key is null, not an error', async () => {
  const missing = { status: 404, headers: { 'X-Open-Publish-Miss': 'key' }, text: '{"error":"No such key."}' }
  assert.equal(await new GatewayDestination(config, recorder([missing]).client).get('objects/ab/x'), null)
  assert.equal(await new GatewayDestination(config, recorder([missing]).client).head('objects/ab/x'), null)
  assert.equal(await new GatewayDestination(config, recorder([missing]).client).getWithEtag('objects/ab/x'), null)
})

test('HEAD reports size and etag for the dedupe fast path', async () => {
  const { client } = recorder([{ status: 200, headers: { 'Content-Length': '4211', ETag: '"abc123"' } }])
  assert.deepEqual(await new GatewayDestination(config, client).head('objects/ab/abcd'), {
    size: 4211,
    etag: 'abc123',
  })
})

test('getWithEtag hands back the body and its etag, so a later write can use If-Match', async () => {
  const body = new TextEncoder().encode('{"v":1}').buffer
  const { client } = recorder([{ status: 200, headers: { etag: 'W/"abc"' }, arrayBuffer: body }])
  const result = await new GatewayDestination(config, client).getWithEtag('current.json')
  assert.equal(result.etag, 'abc', 'weak and quoted forms are normalised, exactly as on S3')
  assert.equal(result.body, body)
})

test('a 404 that is not about a missing key is a wrong address, not an empty site', async () => {
  // The dangerous shape. `scanner.ts` reads a null pointer as "nothing has ever
  // been published", so answering null here shows somebody their whole vault as
  // unpublished and blames nothing.
  //
  // The second case is the one the gateway signature alone got wrong: a Worker
  // address carrying a path its routes do not serve (`https://example.com/gw`)
  // is answered by the real gateway, signed, with a 404 that means "no such
  // route" rather than "no such key".
  for (const response of [
    { status: 404, text: '<html>404 not found</html>' },
    { status: 404, headers: { 'X-Open-Publish-Gateway': '1' }, text: '{"error":"Not a gateway route."}' },
  ]) {
    const { client } = recorder([response])
    await assert.rejects(
      () => new GatewayDestination(config, client).get('current.json'),
      (error) => error.code === 'storage-missing-bucket' && /not an Open Publish gateway/.test(error.message),
    )
  }
})

test('reads never come from a cache, and a fresh read gets a URL nothing can have cached', async () => {
  const signed = { status: 404, headers: { 'X-Open-Publish-Miss': 'key' } }
  const { client, calls } = recorder([signed, signed])
  const destination = new GatewayDestination(config, client)
  await destination.get('current.json')
  assert.equal(calls[0].headers['Cache-Control'], 'no-cache')
  assert.doesNotMatch(calls[0].url, /x-op-fresh/)

  await destination.get('current.json', { fresh: true })
  assert.match(calls[1].url, /\/o\/current\.json\?x-op-fresh=/)
})

// --- writes --------------------------------------------------------------

test('conditional headers go out as HTTP conditionals, quoted the way etags are', async () => {
  const { client, calls } = recorder([{ status: 200, headers: { etag: '"new"' } }])
  const result = await new GatewayDestination(config, client).put('current.json', new ArrayBuffer(2), {
    ifMatch: 'old',
  })
  assert.equal(calls[0].method, 'PUT')
  assert.equal(calls[0].headers['If-Match'], '"old"')
  assert.equal(result.etag, 'new')
})

test('If-None-Match: * is the one form that is never quoted', async () => {
  const { client, calls } = recorder([{ status: 200, headers: { etag: '"new"' } }])
  await new GatewayDestination(config, client).put('guard.json', new ArrayBuffer(2), { ifNoneMatch: '*' })
  assert.equal(calls[0].headers['If-None-Match'], '*')
})

test('a content type is inferred from the key when the caller does not give one', async () => {
  const { client, calls } = recorder()
  await new GatewayDestination(config, client).put('current.json', new ArrayBuffer(1))
  assert.equal(calls[0].contentType, 'application/json')
})

test('both conditional writes surface as storage-conflict, because publisher.ts depends on it', async () => {
  for (const options of [{ ifMatch: 'stale' }, { ifNoneMatch: '*' }]) {
    const { client } = recorder([{ status: 412, text: '{"error":"That key already exists."}' }])
    await assert.rejects(
      () => new GatewayDestination(config, client).put('current.json', new ArrayBuffer(2), options),
      (error) => error.code === 'storage-conflict' && /Another device published/.test(error.hint),
    )
  }
})

test('a delete of an already-missing key is a success', async () => {
  const { client } = recorder([{ status: 404, headers: { 'X-Open-Publish-Miss': 'key' } }])
  await new GatewayDestination(config, client).delete('objects/ab/gone')
})

// --- errors, in words ----------------------------------------------------

test('gateway failures are sentences about a Worker, never bare status codes', async () => {
  const cases = [
    [{ status: 401, text: '{"error":"Unauthorized."}' }, 'storage-credentials', /rejected this token/],
    [{ status: 403, text: '{"error":"Unauthorized."}' }, 'storage-credentials', /rejected this token/],
    [{ status: 500, text: '{"error":"boom"}' }, 'storage-failed', /unexpected error/],
    [{ status: 0, text: 'net::ERR_NAME_NOT_RESOLVED' }, 'storage-unreachable', /Couldn't reach the Worker/],
  ]
  for (const [response, code, message] of cases) {
    const { client } = recorder([response])
    await assert.rejects(
      () => new GatewayDestination(config, client).put('current.json', new ArrayBuffer(1)),
      (error) => {
        assert.equal(error.code, code, `${response.status} mapped to ${error.code}`)
        assert.match(error.message, message)
        assert.doesNotMatch(error.message, /^\d{3}$/)
        return true
      },
    )
  }
})

test('a wrong address answers, and is told apart from a wrong token', async () => {
  // The Worker holds the bucket name, so a route-level 404 can only mean the
  // address is not a gateway. Sending that user off to check their token is
  // sending them to the one screen that is already correct.
  const { client } = recorder([{ status: 404, text: 'not found' }])
  await assert.rejects(
    () => new GatewayDestination(config, client).list('objects/'),
    (error) => error.code === 'storage-missing-bucket' && /not an Open Publish gateway/.test(error.message),
  )
})

test('the Worker\'s own message is carried through rather than swallowed', async () => {
  const { client } = recorder([{ status: 400, text: '{"error":"That key is not allowed."}' }])
  await assert.rejects(
    () => new GatewayDestination(config, client).put('../escape', new ArrayBuffer(1)),
    (error) => error.message === 'That key is not allowed.',
  )
})

// --- listing -------------------------------------------------------------

test('list pages through cursors and strips the configured prefix', async () => {
  const { client, calls } = recorder([
    json({
      entries: [{ key: 'sites/notes/objects/ab/one', size: 10, lastModified: 1 }],
      cursor: 'next/1',
    }),
    json({ entries: [{ key: 'sites/notes/objects/cd/two', size: 20, lastModified: 2 }] }),
  ])
  const entries = await new GatewayDestination({ ...config, prefix: 'sites/notes' }, client).list('objects/')

  assert.deepEqual(entries, [
    { key: 'objects/ab/one', size: 10, lastModified: 1 },
    { key: 'objects/cd/two', size: 20, lastModified: 2 },
  ])
  assert.match(calls[0].url, /\/l\?prefix=sites%2Fnotes%2Fobjects%2F$/)
  assert.match(calls[1].url, /cursor=next%2F1/)
})

test('a listing that never says it is done still terminates', async () => {
  const { client } = recorder([json({ entries: [], cursor: '' })])
  assert.deepEqual(await new GatewayDestination(config, client).list('objects/'), [])
})

test('a malformed listing is a failure with a sentence, not a SyntaxError', async () => {
  const { client } = recorder([{ status: 200, text: 'not json at all' }])
  await assert.rejects(
    () => new GatewayDestination(config, client).list('objects/'),
    (error) => error.name === 'PublishError' && error.code === 'storage-failed',
  )
})

test('entries missing the fields we need are skipped rather than becoming NaN', async () => {
  const { client } = recorder([json({ entries: [{ size: 1 }, { key: 'ok', size: 'x' }] })])
  assert.deepEqual(await new GatewayDestination(config, client).list(''), [{ key: 'ok', size: 0 }])
})

// --- Test connection -----------------------------------------------------

/**
 * A transport that round-trips one object, and answers the conditional write at
 * the end of the connection test however the caller asks it to. The same shape
 * as the one in `s3.test.mjs`, because it is testing the same shared check.
 */
function testTransport({ onConditionalPut }) {
  const payload = { value: null }
  const calls = []
  const client = async (request) => {
    calls.push(request.method)
    if (request.method === 'PUT') {
      if (request.headers['If-Match']) return onConditionalPut(request)
      payload.value = request.body
      return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
    }
    if (request.method === 'GET') return { status: 200, headers: {}, arrayBuffer: payload.value, text: '' }
    return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
  }
  return { client, calls }
}

const refused = { status: 412, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
const accepted = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }

test('the connection test writes, reads back, compares, probes and cleans up', async () => {
  const { client, calls } = testTransport({ onConditionalPut: () => refused })
  const result = await new GatewayDestination(config, client).test()
  assert.deepEqual(result, { ok: true, conditionalWrites: 'enforced' })
  assert.deepEqual(calls, ['PUT', 'GET', 'PUT', 'DELETE'])
})

test('a gateway that accepted a write it should have refused is reported, not passed over', async () => {
  const { client } = testTransport({ onConditionalPut: () => accepted })
  assert.deepEqual(await new GatewayDestination(config, client).test(), { ok: true, conditionalWrites: 'ignored' })
})

test('a probe that could not run says nothing, rather than saying "unsupported"', async () => {
  const { client } = testTransport({
    onConditionalPut: () => ({ status: 503, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }),
  })
  const destination = new GatewayDestination(config, client)
  assert.deepEqual(await destination.test(), { ok: true, conditionalWrites: undefined })
  assert.equal(destination.supportsConditionalWrites(), true)
})

test('a rejected token fails the connection test in the user\'s own terms', async () => {
  const { client } = recorder([{ status: 401, text: '{"error":"Unauthorized."}' }])
  const result = await new GatewayDestination(config, client).test()
  assert.equal(result.ok, false)
  assert.match(result.reason, /rejected this token/)
  assert.match(result.hint, /wrangler secret put TOKEN/)
})
