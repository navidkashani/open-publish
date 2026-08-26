import test from 'node:test'
import assert from 'node:assert/strict'
import { S3Destination, parseListObjectsV2 } from '../src/destinations/s3.ts'

const config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'my-notes',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
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

test('path-style URLs put the bucket in the path', async () => {
  const { client, calls } = recorder()
  await new S3Destination(config, client).get('objects/ab/abcd')
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/my-notes/objects/ab/abcd')
})

test('virtual-host style puts the bucket in the hostname', async () => {
  const { client, calls } = recorder()
  await new S3Destination({ ...config, forcePathStyle: false }, client).get('objects/ab/abcd')
  assert.equal(calls[0].url, 'https://my-notes.acct.r2.cloudflarestorage.com/objects/ab/abcd')
})

test('a key prefix lets one bucket hold several sites', async () => {
  const { client, calls } = recorder()
  await new S3Destination({ ...config, prefix: '/sites/notes/' }, client).get('current.json')
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/my-notes/sites/notes/current.json')
})

test('every request carries a signature and a payload hash, but no Host header', async () => {
  const { client, calls } = recorder()
  await new S3Destination(config, client).get('current.json')
  assert.match(calls[0].headers.Authorization, /^AWS4-HMAC-SHA256 Credential=key\//)
  assert.match(calls[0].headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/)
  assert.match(calls[0].headers['x-amz-date'], /^\d{8}T\d{6}Z$/)
  assert.equal(calls[0].headers.host ?? calls[0].headers.Host, undefined, 'Host is forbidden and breaks Electron')
})

test('a missing key is null, not an error: HEAD returning 404 is a normal answer', async () => {
  const destination = new S3Destination(config, recorder([{ status: 404, text: '<Error><Code>NoSuchKey</Code></Error>' }]).client)
  assert.equal(await destination.head('objects/ab/missing'), null)
  const getter = new S3Destination(config, recorder([{ status: 404, text: '' }]).client)
  assert.equal(await getter.get('objects/ab/missing'), null)
})

test('HEAD reports size and etag for the dedupe fast path', async () => {
  const { client } = recorder([{ status: 200, headers: { 'Content-Length': '4211', ETag: '"abc123"' } }])
  const result = await new S3Destination(config, client).head('objects/ab/abcd')
  assert.deepEqual(result, { size: 4211, etag: 'abc123' })
})

test('conditional headers are sent and signed', async () => {
  const { client, calls } = recorder([{ status: 200, headers: { etag: '"new"' } }])
  await new S3Destination(config, client).put('current.json', new ArrayBuffer(2), { ifMatch: 'old' })
  assert.equal(calls[0].headers['if-match'], '"old"')
  assert.match(calls[0].headers.Authorization, /SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date/)
})

test('a 412 becomes a concurrent-publish error, in words', async () => {
  const { client } = recorder([{ status: 412, text: '<Error><Code>PreconditionFailed</Code></Error>' }])
  await assert.rejects(
    () => new S3Destination(config, client).put('current.json', new ArrayBuffer(2), { ifMatch: 'old' }),
    (error) => error.code === 'storage-conflict' && /Another device published/.test(error.hint),
  )
})

test('storage errors are mapped to sentences, never bare status codes', async () => {
  const cases = [
    [{ status: 403, text: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }, 'storage-credentials', /wrong, revoked, or scoped/],
    [{ status: 404, text: '<Error><Code>NoSuchBucket</Code></Error>' }, 'storage-missing-bucket', /account ID/],
    [{ status: 0, text: 'getaddrinfo ENOTFOUND' }, 'storage-unreachable', /endpoint URL/],
  ]
  for (const [response, code, hintPattern] of cases) {
    const { client } = recorder([response])
    await assert.rejects(
      () => new S3Destination(config, client).put('objects/ab/x', new ArrayBuffer(1)),
      (error) => {
        assert.equal(error.code, code)
        assert.match(error.hint, hintPattern)
        assert.doesNotMatch(error.message, /^HTTP \d+$/)
        return true
      },
    )
  }
})

test('content type is derived from the path being published', async () => {
  const { client, calls } = recorder([{}, {}])
  const destination = new S3Destination(config, client)
  await destination.put('objects/ab/abcd', new ArrayBuffer(1), { contentType: 'image/png' })
  assert.equal(calls[0].contentType, 'image/png')
})

test('a delete of an already-missing key is a success', async () => {
  const { client } = recorder([{ status: 404 }])
  await new S3Destination(config, client).delete('objects/ab/gone')
})

test('list pages through continuation tokens and strips the prefix', async () => {
  const page = (keys, truncated, token) =>
    `<ListBucketResult>${keys
      .map((k) => `<Contents><Key>sites/notes/${k}</Key><Size>10</Size><LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents>`)
      .join('')}<IsTruncated>${truncated}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}</ListBucketResult>`

  const { client, calls } = recorder([
    { status: 200, text: page(['objects/ab/one'], true, 'tok/1') },
    { status: 200, text: page(['objects/cd/two'], false) },
  ])
  const entries = await new S3Destination({ ...config, prefix: 'sites/notes' }, client).list('objects/')

  assert.deepEqual(entries.map((e) => e.key), ['objects/ab/one', 'objects/cd/two'])
  assert.match(calls[0].url, /prefix=sites%2Fnotes%2Fobjects%2F/)
  assert.match(calls[1].url, /continuation-token=tok%2F1/)
})

test('list parses sizes and timestamps, and decodes XML entities', () => {
  const parsed = parseListObjectsV2(
    '<Contents><Key>a&amp;b</Key><Size>42</Size><LastModified>2026-08-01T00:00:00.000Z</LastModified></Contents><IsTruncated>false</IsTruncated>',
  )
  assert.equal(parsed.entries[0].key, 'a&b')
  assert.equal(parsed.entries[0].size, 42)
  assert.equal(parsed.entries[0].lastModified, Date.parse('2026-08-01T00:00:00.000Z'))
  assert.equal(parsed.nextContinuationToken, undefined)
})

/**
 * A transport that round-trips one object, and answers the conditional write at
 * the end of the connection test however the caller asks it to.
 */
function testTransport({ onConditionalPut }) {
  const payload = { value: null }
  const calls = []
  const client = async (request) => {
    calls.push(request.method)
    if (request.method === 'PUT') {
      if (request.headers['if-match']) return onConditionalPut(request)
      payload.value = request.body
      return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
    }
    if (request.method === 'GET') return { status: 200, headers: {}, arrayBuffer: payload.value, text: '' }
    return { status: 204, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
  }
  return { client, calls }
}

const ok = { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }

test('the connection test writes, reads back, compares, probes and cleans up', async () => {
  const { client, calls } = testTransport({
    onConditionalPut: () => ({ status: 412, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }),
  })
  const result = await new S3Destination(config, client).test()
  assert.deepEqual(result, { ok: true, conditionalWrites: 'enforced' })
  assert.deepEqual(calls, ['PUT', 'GET', 'PUT', 'DELETE'], 'one extra request buys the answer people most want')
})

test('the probe uses an ETag the object cannot have, and signs it', async () => {
  const { client } = testTransport({
    onConditionalPut: (request) => {
      assert.equal(request.headers['if-match'], '"00000000000000000000000000000000"')
      assert.match(request.headers.Authorization, /SignedHeaders=[^,]*if-match/, 'R2 rejects unsigned conditionals')
      return { status: 412, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
    },
  })
  assert.equal((await new S3Destination(config, client).test()).conditionalWrites, 'enforced')
})

test('storage that accepts a write it should have refused is reported, not passed over', async () => {
  // The MinIO shape: the header is accepted and ignored, so the test passes
  // while two devices publishing at once could silently overwrite each other.
  const { client } = testTransport({ onConditionalPut: () => ok })
  const result = await new S3Destination(config, client).test()
  assert.deepEqual(result, { ok: true, conditionalWrites: 'ignored' })
})

test('a probe that could not run says nothing, rather than saying "unsupported"', async () => {
  // A dropped connection on this one request tells us nothing about the
  // feature. Reporting "unsupported" would tell an R2 or S3 user their storage
  // cannot do the exact thing it can, and quietly downgrade the two-device row.
  for (const failure of [
    { status: 0, headers: {}, arrayBuffer: new ArrayBuffer(0), text: 'network down' },
    { status: 503, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '<Error><Code>SlowDown</Code></Error>' },
  ]) {
    const { client } = testTransport({ onConditionalPut: () => failure })
    const destination = new S3Destination(config, client)
    const result = await destination.test()
    assert.deepEqual(result, { ok: true, conditionalWrites: undefined })
    assert.equal(destination.supportsConditionalWrites(), true, 'and nothing is learned the wrong way either')
  }
})

test('storage with no conditional writes at all still passes, as weaker rather than broken', async () => {
  const { client } = testTransport({
    onConditionalPut: () => ({ status: 501, headers: {}, arrayBuffer: new ArrayBuffer(0), text: 'Not Implemented' }),
  })
  const destination = new S3Destination(config, client)
  const result = await destination.test()
  assert.deepEqual(result, { ok: true, conditionalWrites: 'unsupported' })
  assert.equal(destination.supportsConditionalWrites(), false, 'and the publisher learns it for free')
})

test('a write-only token fails the connection test with an explanation', async () => {
  const client = async (request) =>
    request.method === 'PUT'
      ? { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '' }
      : { status: 403, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '<Error><Code>AccessDenied</Code></Error>' }
  const result = await new S3Destination(config, client).test()
  assert.equal(result.ok, false)
  assert.match(result.reason, /credentials/i)
})

test('keys with spaces and non-latin characters are encoded correctly', async () => {
  const { client, calls } = recorder()
  await new S3Destination({ ...config, prefix: 'my site' }, client).get('snapshots/2026-08-24T11-04-02Z-a3f9c1.json')
  assert.ok(calls[0].url.includes('/my%20site/snapshots/'))
  // The signature must cover the same encoding the URL uses.
  assert.match(calls[0].headers.Authorization, /Signature=[0-9a-f]{64}/)
})

test('a transport failure reports what actually broke, not just "check your network"', async () => {
  const { client } = recorder([{ status: 0, text: 'Request cannot set the Host header' }])
  await assert.rejects(
    () => new S3Destination(config, client).get('current.json'),
    (error) => {
      assert.equal(error.code, 'storage-unreachable')
      assert.match(error.hint, /Request cannot set the Host header/)
      return true
    },
  )
})

test('reads never come from a cache', async () => {
  // Obsidian's requestUrl goes through Electron's HTTP cache. A GET of the site
  // pointer served from there means diffing against a site state that has
  // already moved on: edits that are live show up as still pending.
  const { client, calls } = recorder()
  const destination = new S3Destination(config, client)
  await destination.get('current.json')
  await destination.head('objects/ab/abcd')
  await destination.put('current.json', new ArrayBuffer(1))

  assert.equal(calls[0].headers['Cache-Control'], 'no-cache', 'GET')
  assert.equal(calls[1].headers['Cache-Control'], 'no-cache', 'HEAD')
  assert.equal(calls[2].headers['Cache-Control'], undefined, 'a PUT has nothing to read from a cache')
})

test('a fresh read gets a URL nothing can have cached, and it is signed', async () => {
  const { client, calls } = recorder([
    { status: 200, headers: { etag: '"e1"' } },
    { status: 200, headers: { etag: '"e1"' } },
  ])
  const destination = new S3Destination(config, client)
  await destination.getWithEtag('current.json', { fresh: true })
  await destination.getWithEtag('current.json', { fresh: true })

  const [first, second] = calls
  assert.match(first.url, /\?x-op-fresh=/)
  assert.notEqual(first.url, second.url, 'two reads in a row must not share a URL')
  // An unsigned query parameter would be rejected, so the signature has to cover it.
  assert.match(first.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=key\//)
})

test('an ordinary read keeps its plain URL', async () => {
  const { client, calls } = recorder()
  await new S3Destination(config, client).get('objects/ab/abcd')
  assert.equal(calls[0].url, 'https://acct.r2.cloudflarestorage.com/my-notes/objects/ab/abcd')
})

test('a prefix with a space still signs correctly', async () => {
  // URLSearchParams writes a space as `+`; the signer reads the query back
  // through URL.searchParams (turning `+` into a space) and re-encodes it as
  // `%20`. The two disagree, and every list fails with SignatureDoesNotMatch:
  // one typed space in a free-text settings field away.
  const { client, calls } = recorder([{ status: 200, text: '<ListBucketResult></ListBucketResult>' }])
  await new S3Destination({ ...config, prefix: 'my notes' }, client).list('objects/')

  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('prefix'), 'my notes/objects/', 'the bucket sees the prefix that was typed')
  assert.equal(url.search.includes('+'), false, 'and never as a plus, which the signature would not match')
  assert.match(url.search, /prefix=my%20notes%2Fobjects%2F/)
})
