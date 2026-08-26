import test from 'node:test'
import assert from 'node:assert/strict'
import { Publisher, narrowSnapshot, throttleState } from '../src/core/publisher.ts'
import { computeSnapshotId, CURRENT_KEY, objectKey, snapshotKey, parseSnapshot } from '../src/core/snapshot.ts'
import { PublishError } from '../src/core/errors.ts'
import { FakeDestination, bytes, makeScan, site } from './helpers.mjs'

const contents = { 'a.md': 'note a', 'b.md': 'note b', 'img.png': 'binary-ish' }
const hashes = {
  'a.md': 'aa'.repeat(32),
  'b.md': 'bb'.repeat(32),
  'img.png': 'cc'.repeat(32),
}
const files = Object.fromEntries(
  Object.entries(hashes).map(([path, hash]) => [path, { hash, size: 6, mtime: 1, slug: path.replace(/\.md$/, '') }]),
)

const baseInput = (destination, overrides = {}) => ({
  scan: makeScan({ files }),
  selectedPaths: new Set(Object.keys(files)),
  destination,
  builder: null,
  readFile: async (path) => bytes(contents[path]),
  site,
  pluginVersion: '0.1.0',
  autoTrigger: false,
  minIntervalMinutes: 0,
  lastBuildTriggeredAt: null,
  ...overrides,
})

test('the mutable pointer is written last: this is the whole atomicity guarantee', async () => {
  const destination = new FakeDestination()
  const outcome = await new Publisher().publish(baseInput(destination), () => {})

  const writes = destination.writeOrder()
  assert.equal(writes.at(-1), CURRENT_KEY, 'current.json must be the final write')
  assert.equal(writes.at(-2), snapshotKey(outcome.snapshotId), 'the snapshot is committed just before the pointer')
  assert.ok(
    writes.slice(0, 3).every((key) => key.startsWith('objects/')),
    'every content object lands before either manifest',
  )
})

test('an interrupted upload leaves the live site untouched', async () => {
  const destination = new FakeDestination()
  destination.failOn = (key, method) =>
    method === 'PUT' && key === objectKey(hashes['b.md']) ? new Error('network died') : null

  await assert.rejects(() => new Publisher().publish(baseInput(destination), () => {}))

  assert.equal(destination.objects.has(CURRENT_KEY), false, 'no pointer, so no site change')
  assert.equal([...destination.objects.keys()].some((k) => k.startsWith('snapshots/')), false)
  assert.ok(destination.objects.has(objectKey(hashes['a.md'])), 'orphan objects are left behind, and are harmless')
})

test('a resumed publish re-uses objects already in the bucket', async () => {
  const destination = new FakeDestination()
  await new Publisher().publish(baseInput(destination), () => {})

  // Simulate a fresh run of the very same content.
  destination.log.length = 0
  const events = []
  const outcome = await new Publisher().publish(
    baseInput(destination, { scan: makeScan({ files, isFirstPublish: false }) }),
    (event) => events.push(event),
  )

  assert.equal(outcome.uploaded, 0)
  assert.equal(outcome.skipped, 3)
  assert.equal(destination.writeOrder().filter((k) => k.startsWith('objects/')).length, 0, 'nothing re-uploaded')
})

test('identical files upload once, however many paths share them', async () => {
  const destination = new FakeDestination()
  const duplicated = {
    'one.md': { hash: 'dd'.repeat(32), size: 3, mtime: 1, slug: 'one' },
    'two.md': { hash: 'dd'.repeat(32), size: 3, mtime: 1, slug: 'two' },
  }
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files: duplicated }),
      selectedPaths: new Set(['one.md', 'two.md']),
      readFile: async () => bytes('same'),
    }),
    () => {},
  )
  assert.equal(outcome.uploaded, 1)
  assert.equal(destination.writeOrder().filter((k) => k.startsWith('objects/')).length, 1)
})

test('no changes means no build: free-tier build quota is not spent on a no-op', async () => {
  const destination = new FakeDestination()
  const previousId = await computeSnapshotId(files, site, 1_700_000_000_000)
  const previous = { version: 1, id: previousId, parent: null, createdAt: 1_700_000_000_000,
    generator: { plugin: 'open-publish', version: '0.1.0' }, site, files, links: {}, redirects: [] }

  let triggered = false
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous, isFirstPublish: false, currentEtag: 'etag-1' }),
      autoTrigger: true,
      builder: { id: 'x', test: async () => ({ ok: true }), trigger: async () => { triggered = true; return { accepted: true } },
        waitForDeploy: async function* () { yield { state: 'live' } } },
    }),
    () => {},
  )

  assert.equal(outcome.committed, false)
  assert.equal(triggered, false, 'no build was started')
  assert.equal(destination.log.length, 0, 'and no network traffic at all')
})

test('a second device publishing first is rejected by compare-and-swap, never silently overwritten', async () => {
  const destination = new FakeDestination()
  // Device A publishes.
  await new Publisher().publish(baseInput(destination), () => {})
  const afterA = destination.text(CURRENT_KEY)

  // Device B started from a stale read of current.json.
  const stale = makeScan({ files: { 'c.md': { hash: 'ee'.repeat(32), size: 1, mtime: 1, slug: 'c' } },
    isFirstPublish: false, currentEtag: 'etag-from-an-older-read' })

  await assert.rejects(
    () => new Publisher().publish(
      baseInput(destination, { scan: stale, selectedPaths: new Set(['c.md']), readFile: async () => bytes('c') }),
      () => {},
    ),
    (error) => error instanceof PublishError && error.code === 'storage-conflict',
  )
  assert.equal(destination.text(CURRENT_KEY), afterA, "device A's publish is intact")
})

test('the first publish uses If-None-Match so it cannot clobber an existing site', async () => {
  const destination = new FakeDestination()
  destination.objects.set(CURRENT_KEY, { body: bytes('{"snapshot":"someone-elses"}'), etag: 'e0', lastModified: 0 })

  await assert.rejects(
    () => new Publisher().publish(baseInput(destination), () => {}),
    (error) => error instanceof PublishError && error.code === 'storage-conflict',
  )
})

test('a provider without conditional writes degrades to read-then-warn, not to corruption', async () => {
  const destination = new FakeDestination({ conditionalWrites: false })
  const outcome = await new Publisher().publish(baseInput(destination), () => {})
  assert.equal(outcome.committed, true)
  assert.equal(destination.writeOrder().at(-1), CURRENT_KEY)
})

test('a conflict is never retried: a precondition failure is an answer, not a blip', async () => {
  const destination = new FakeDestination()
  destination.objects.set(CURRENT_KEY, { body: bytes('{}'), etag: 'e0', lastModified: 0 })
  let pointerPuts = 0
  const original = destination.put.bind(destination)
  destination.put = async (key, body, options) => {
    if (key === CURRENT_KEY) pointerPuts++
    return original(key, body, options)
  }
  await assert.rejects(() => new Publisher().publish(baseInput(destination), () => {}))
  assert.equal(pointerPuts, 1)
})

test('a transient upload failure is retried and then succeeds', async () => {
  const destination = new FakeDestination()
  let failures = 0
  destination.failOn = (key, method) => {
    if (method === 'PUT' && key === objectKey(hashes['a.md']) && failures < 2) {
      failures++
      return new Error('temporary')
    }
    return null
  }
  const outcome = await new Publisher().publish(baseInput(destination), () => {})
  assert.equal(outcome.uploaded, 3)
  assert.equal(failures, 2)
})

test('bad credentials fail immediately instead of retrying three times', async () => {
  const destination = new FakeDestination()
  let attempts = 0
  destination.failOn = (key, method) => {
    if (method === 'PUT' && key.startsWith('objects/')) {
      attempts++
      return new PublishError('storage-credentials', 'Storage rejected these credentials.')
    }
    return null
  }
  await assert.rejects(() => new Publisher().publish(baseInput(destination), () => {}))
  assert.equal(attempts, 3, 'one attempt per file, none retried')
})

test('a scan with blockers cannot be published', async () => {
  const destination = new FakeDestination()
  const scan = makeScan({ files, blockers: [{ kind: 'slug-collision', message: 'Two files claim /a', paths: ['A.md', 'a.md'] }] })
  await assert.rejects(
    () => new Publisher().publish(baseInput(destination, { scan }), () => {}),
    /Two files claim \/a/,
  )
  assert.equal(destination.log.length, 0)
})

test('clicking publish twice joins the running publish rather than starting a second', async () => {
  const destination = new FakeDestination()
  const publisher = new Publisher()
  const input = baseInput(destination)
  const [first, second] = await Promise.all([
    publisher.publish(input, () => {}),
    publisher.publish(input, () => {}),
  ])
  assert.equal(first.snapshotId, second.snapshotId)
  assert.equal(destination.writeOrder().filter((k) => k === CURRENT_KEY).length, 1)
  assert.equal(publisher.isPublishing(), false, 'the flight lock is released afterwards')
})

test('the committed snapshot is valid and points at its parent', async () => {
  const destination = new FakeDestination()
  const outcome = await new Publisher().publish(baseInput(destination), () => {})
  const snapshot = parseSnapshot(destination.text(snapshotKey(outcome.snapshotId)))
  assert.equal(snapshot.id, outcome.snapshotId)
  assert.deepEqual(Object.keys(snapshot.files).sort(), ['a.md', 'b.md', 'img.png'])
  assert.equal(JSON.parse(destination.text(CURRENT_KEY)).snapshot, outcome.snapshotId)
})

test('unticking a file removes it from the snapshot and flips links pointing at it', async () => {
  const full = {
    version: 1, id: 'x', parent: null, createdAt: 0,
    generator: { plugin: 'open-publish', version: '0.1.0' }, site,
    files: { 'a.md': files['a.md'], 'b.md': files['b.md'] },
    links: { 'a.md': [{ raw: 'b', target: 'b.md', status: 'published', slug: 'b' }] },
    redirects: [],
  }
  const narrowed = await narrowSnapshot(full, new Set(['a.md']), site, '0.1.0')
  assert.deepEqual(Object.keys(narrowed.files), ['a.md'])
  assert.equal(narrowed.links['a.md'][0].status, 'unpublished')
  assert.equal(narrowed.links['a.md'][0].slug, undefined, 'no slug is emitted for a page that will not exist')
})

test('re-ticking a file restores the published link status and its slug', async () => {
  const full = {
    version: 1, id: 'x', parent: null, createdAt: 0,
    generator: { plugin: 'open-publish', version: '0.1.0' }, site,
    files: { 'a.md': files['a.md'], 'b.md': files['b.md'] },
    links: { 'a.md': [{ raw: 'b', target: 'b.md', status: 'unpublished' }] },
    redirects: [],
  }
  const narrowed = await narrowSnapshot(full, new Set(['a.md', 'b.md']), site, '0.1.0')
  assert.equal(narrowed.links['a.md'][0].status, 'published')
  assert.equal(narrowed.links['a.md'][0].slug, 'b')
})

test('build throttling holds a build back inside the window', () => {
  assert.equal(throttleState(Date.now() - 60_000, 5).throttled, true)
  assert.equal(throttleState(Date.now() - 10 * 60_000, 5).throttled, false)
  assert.equal(throttleState(null, 5).throttled, false)
  assert.equal(throttleState(Date.now(), 0).throttled, false, 'zero disables throttling')
})

test('content is committed even when the deploy hook fails, and the failure is reported', async () => {
  const destination = new FakeDestination()
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      autoTrigger: true,
      builder: {
        id: 'x',
        test: async () => ({ ok: true }),
        trigger: async () => { throw new PublishError('hook-rejected', 'The deploy hook was rejected.') },
        waitForDeploy: async function* () { yield { state: 'live' } },
      },
    }),
    () => {},
  )
  assert.equal(outcome.committed, true)
  assert.equal(outcome.buildTriggered, false)
  assert.equal(outcome.deployWarning?.code, 'hook-rejected')
  assert.ok(destination.objects.has(CURRENT_KEY), 'the content is live regardless')
})

test('a build that never goes live is reported as a warning, not a failed publish', async () => {
  const destination = new FakeDestination()
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      autoTrigger: true,
      verifyTimeoutMs: 50,
      logsUrl: 'https://logs.example',
      builder: {
        id: 'x',
        test: async () => ({ ok: true }),
        trigger: async () => ({ accepted: true }),
        waitForDeploy: async function* () { yield { state: 'pending' }; yield { state: 'timeout' } },
      },
    }),
    () => {},
  )
  assert.equal(outcome.committed, true)
  assert.equal(outcome.deployWarning?.code, 'verify-timeout')
  assert.match(outcome.deployWarning.hint, /logs\.example/)
})

test('a provider that hides its ETag falls back to read-then-warn, not to a silent overwrite', async () => {
  // If conditional writes are supported but the GET came back without an ETag
  // (a proxy that strips it, a destination with no getWithEtag), there is nothing
  // to compare against. Writing anyway is the one outcome the whole design
  // exists to prevent: device B overwrites device A with no error.
  const destination = new FakeDestination()
  await new Publisher().publish(baseInput(destination), () => {})
  const afterA = destination.text(CURRENT_KEY)
  const previousId = JSON.parse(afterA).snapshot

  // Device B read current.json before A published, and got no ETag at all.
  const stale = makeScan({
    files: { 'c.md': { hash: 'ee'.repeat(32), size: 1, mtime: 1, slug: 'c' } },
    previous: { version: 1, id: 'something-older', parent: null, createdAt: 0,
      generator: { plugin: 'open-publish', version: '0.1.0' }, site, files: {}, links: {}, redirects: [] },
    isFirstPublish: false,
    currentEtag: undefined,
  })

  await assert.rejects(
    () => new Publisher().publish(
      baseInput(destination, { scan: stale, selectedPaths: new Set(['c.md']), readFile: async () => bytes('c') }),
      () => {},
    ),
    (error) => error instanceof PublishError && error.code === 'storage-conflict',
  )
  assert.equal(JSON.parse(destination.text(CURRENT_KEY)).snapshot, previousId, "device A's publish is intact")
})
