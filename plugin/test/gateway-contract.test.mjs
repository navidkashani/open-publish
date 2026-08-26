/**
 * The plugin's real gateway client, against the real Worker, in one process.
 *
 * Every other test of this feature proves one half against a fake of the other,
 * and both fakes were written by whoever wrote the code. That is the shape
 * where two suites agree with each other and disagree with reality: a
 * misunderstanding held consistently on both sides passes everywhere and fails
 * on the first real publish.
 *
 * So nothing here is a stand-in except R2 itself. `GatewayDestination` builds
 * the URLs and headers it would really build, `worker.ts` parses and validates
 * them exactly as it would really parse them, and the transport between them is
 * an adapter rather than a script that returns canned answers.
 *
 * What it cannot prove is the R2 binding's own behaviour, which is why the
 * gateway's README makes the storage self-test a required deploy step rather
 * than an aside. This proves the contract; a deployment proves the platform.
 *
 * This is also the test the repository split would lose. If `gateway/` moves to
 * its own repo, the plugin and the Worker can drift with nothing to say so, and
 * whatever replaces this has to be decided at that point rather than after.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeBucket, installTimingSafeEqual } from '../../gateway/test/fake-r2.mjs'
import { GatewayDestination } from '../src/destinations/gateway.ts'
import { runConnectionTest } from '../src/destinations/connection-test.ts'
import { runSelfTest } from '../src/core/selftest.ts'
import { CURRENT_KEY } from '../src/core/snapshot.ts'

installTimingSafeEqual()
const { default: worker } = await import('../../gateway/src/worker.ts')

const TOKEN = 'a-token-nobody-else-has'
const WORKER_URL = 'https://open-publish-gateway.someone.workers.dev'

/**
 * The adapter that stands where `requestUrl` stands in Obsidian.
 *
 * It does what `obsidian-http.ts` does and nothing more: no throwing on a
 * non-2xx, headers as a plain object, the body as an ArrayBuffer, and the text
 * form decoded from it. If those two ever disagree, this test is lying.
 */
function workerTransport(env, log = []) {
  return async (request) => {
    log.push(`${request.method} ${new URL(request.url).pathname}`)
    const headers = { ...request.headers }
    if (request.contentType) headers['Content-Type'] = request.contentType
    const init = { method: request.method, headers }
    if (request.body !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body
    }

    const response = await worker.fetch(new Request(request.url, init), env)
    const arrayBuffer = await response.arrayBuffer()
    let text = ''
    try {
      text = arrayBuffer.byteLength > 0 ? new TextDecoder().decode(arrayBuffer) : ''
    } catch {
      text = ''
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), arrayBuffer, text }
  }
}

function wire({ prefix, workerPrefix } = {}) {
  const bucket = fakeBucket()
  const log = []
  const env = { BUCKET: bucket, TOKEN, ...(workerPrefix ? { PREFIX: workerPrefix } : {}) }
  const destination = new GatewayDestination(
    { workerUrl: WORKER_URL, token: TOKEN, ...(prefix ? { prefix } : {}) },
    workerTransport(env, log),
  )
  return { destination, bucket, log }
}

const text = (buffer) => new TextDecoder().decode(buffer)
const bytes = (value) => new TextEncoder().encode(value).buffer

// --- the acceptance criterion --------------------------------------------

test('the storage self-test passes end to end, which is what publishing rests on', async () => {
  // The same command the settings screen runs, unchanged, against the real
  // Worker. It covers a content-addressed write, the dedupe HEAD, a read back,
  // the compare-and-swap that protects every publish after the first, and the
  // first-publish guard that Test connection does not reach.
  const { destination } = wire()
  const results = await runSelfTest(destination, 1756000000000)

  assert.deepEqual(results, [
    'content-addressed write: ok',
    'deduplication check (HEAD): ok',
    'read back: ok',
    'concurrent-publish protection: ok',
    'first-publish guard: ok',
    'cleanup: ok',
  ])
})

test('and it leaves nothing behind, on a Worker prefix or without one', async () => {
  for (const options of [{}, { workerPrefix: 'sites/notes' }, { workerPrefix: 'sites/notes', prefix: 'blog' }]) {
    const { destination, bucket } = wire(options)
    await runSelfTest(destination, 1756000000000)
    assert.deepEqual([...bucket.objects.keys()], [], `${JSON.stringify(options)} left objects behind`)
  }
})

test('Test connection reports the conditional write as enforced, not merely accepted', async () => {
  const { destination } = wire()
  assert.deepEqual(await runConnectionTest(destination, 1756000000000), {
    ok: true,
    conditionalWrites: 'enforced',
  })
})

// --- the publish path, verb by verb --------------------------------------

test('a publish-shaped sequence round trips through both halves', async () => {
  const { destination, log } = wire()

  // What publisher.ts does, in the order it does it: check whether the blob is
  // already there, upload it, then commit the pointer conditionally.
  assert.equal(await destination.head('objects/ab/abcd'), null)
  const written = await destination.put('objects/ab/abcd', bytes('# Notes'), { contentType: 'text/markdown' })
  assert.ok(written.etag)

  const found = await destination.head('objects/ab/abcd')
  assert.equal(found.size, 7, 'the dedupe fast path needs a real size, not a zero')
  assert.equal(found.etag, written.etag)

  const pointer = await destination.put(CURRENT_KEY, bytes('{"snapshot":"one"}'), { ifNoneMatch: '*' })
  const read = await destination.getWithEtag(CURRENT_KEY, { fresh: true })
  assert.equal(text(read.body), '{"snapshot":"one"}')
  assert.equal(read.etag, pointer.etag, 'scanner reads the etag that publisher then writes against')

  await destination.put(CURRENT_KEY, bytes('{"snapshot":"two"}'), { ifMatch: read.etag })
  assert.equal(text(await destination.get(CURRENT_KEY, { fresh: true })), '{"snapshot":"two"}')

  assert.deepEqual(log.slice(0, 3), [
    'HEAD /o/objects/ab/abcd',
    'PUT /o/objects/ab/abcd',
    'HEAD /o/objects/ab/abcd',
  ])
})

test('a second device publishing against a stale pointer is refused, not silently accepted', async () => {
  // The failure this whole design exists to prevent. If the 412 does not make
  // it back across the wire as storage-conflict, publisher.ts overwrites and a
  // publish is lost with nothing reported.
  const { destination } = wire()
  const first = await destination.put(CURRENT_KEY, bytes('{"v":1}'), { ifNoneMatch: '*' })
  await destination.put(CURRENT_KEY, bytes('{"v":2}'), { ifMatch: first.etag })

  await assert.rejects(
    () => destination.put(CURRENT_KEY, bytes('{"v":3}'), { ifMatch: first.etag }),
    (error) => error.code === 'storage-conflict',
  )
  assert.equal(text(await destination.get(CURRENT_KEY, { fresh: true })), '{"v":2}')
})

test('two devices publishing for the first time at once: the second is refused', async () => {
  const { destination } = wire()
  await destination.put(CURRENT_KEY, bytes('{"device":"a"}'), { ifNoneMatch: '*' })
  await assert.rejects(
    () => destination.put(CURRENT_KEY, bytes('{"device":"b"}'), { ifNoneMatch: '*' }),
    (error) => error.code === 'storage-conflict',
  )
  assert.equal(text(await destination.get(CURRENT_KEY, { fresh: true })), '{"device":"a"}')
})

// --- prefixes, which is where the two halves could disagree quietly -------

test('both prefixes apply, and neither is visible to the caller', async () => {
  const { destination, bucket } = wire({ prefix: 'blog', workerPrefix: 'sites/notes' })
  await destination.put('objects/ab/abcd', bytes('x'))
  await destination.put('snapshots/2026-08-26T00-00-00Z-abc.json', bytes('{}'))

  assert.deepEqual(
    [...bucket.objects.keys()].sort(),
    ['sites/notes/blog/objects/ab/abcd', 'sites/notes/blog/snapshots/2026-08-26T00-00-00Z-abc.json'],
  )

  // Listing hands back keys relative to both prefixes, so gc.ts can pass them
  // straight to delete() and reach the same objects.
  const listed = await destination.list('objects/')
  assert.deepEqual(listed.map((entry) => entry.key), ['objects/ab/abcd'])

  await destination.delete(listed[0].key)
  assert.deepEqual([...bucket.objects.keys()], ['sites/notes/blog/snapshots/2026-08-26T00-00-00Z-abc.json'])
})

test("one gateway's prefix cannot see another's objects", async () => {
  const { destination, bucket } = wire({ workerPrefix: 'sites/notes' })
  bucket.objects.set('sites/notes-other/objects/ab/theirs', {
    key: 'sites/notes-other/objects/ab/theirs',
    bytes: Buffer.from('x'),
    etag: 'e',
    uploaded: new Date(0),
  })

  // The trailing slash is the whole of it: "sites/notes" as a raw prefix match
  // would also match "sites/notes-other".
  assert.deepEqual(await destination.list(''), [])
})

test('a listing longer than one page is followed to the end', async () => {
  const { destination, bucket } = wire()
  for (let i = 0; i < 5; i++) await destination.put(`objects/ab/${i}`, bytes('x'))
  const paged = bucket.list.bind(bucket)
  bucket.list = (options) => paged({ ...options, limit: 2 })

  const listed = await destination.list('objects/')
  assert.deepEqual(listed.map((entry) => entry.key).sort(), [
    'objects/ab/0',
    'objects/ab/1',
    'objects/ab/2',
    'objects/ab/3',
    'objects/ab/4',
  ])
})

// --- the failures, as the user meets them --------------------------------

test('a wrong token fails as a token problem, not as an empty site', async () => {
  const { destination: real } = wire()
  await real.put(CURRENT_KEY, bytes('{}'))

  const bucket = fakeBucket()
  const wrong = new GatewayDestination(
    { workerUrl: WORKER_URL, token: 'not-the-token' },
    workerTransport({ BUCKET: bucket, TOKEN }),
  )
  await assert.rejects(
    () => wrong.get(CURRENT_KEY),
    (error) => error.code === 'storage-credentials' && /rejected this token/.test(error.message),
  )
})

test('a Worker address carrying a path is a wrong address, not an unpublished vault', async () => {
  // The real shape of this: a Workers route on a custom domain, example.com/gw.
  // The gateway answers, and signs the answer, because it genuinely is the
  // gateway. Only the key-miss marker separates it from a missing object, and
  // reading it as one shows the whole vault as never published.
  const bucket = fakeBucket()
  const destination = new GatewayDestination(
    { workerUrl: 'https://example.com/gw', token: TOKEN },
    workerTransport({ BUCKET: bucket, TOKEN }),
  )
  await assert.rejects(
    () => destination.get(CURRENT_KEY),
    (error) => error.code === 'storage-missing-bucket' && /not an Open Publish gateway/.test(error.message),
  )
})

test('a key the Worker refuses is refused, and says which field to fix', async () => {
  const { destination } = wire({ prefix: 'notes/../elsewhere' })
  await assert.rejects(
    () => destination.list('objects/'),
    (error) => error.code === 'storage-failed' && /key prefix/.test(error.hint),
  )
})
