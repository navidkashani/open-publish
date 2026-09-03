import test from 'node:test'
import assert from 'node:assert/strict'
import { Publisher, narrowSnapshot, throttleState } from '../src/core/publisher.ts'
import { PublishSession } from '../src/core/session.ts'
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

const snapshotOf = (fileMap, id = 'snap-prev') => ({
  version: 1, id, parent: null, createdAt: 1_700_000_000_000,
  generator: { plugin: 'open-publish', version: '0.1.0' }, site, files: fileMap, links: {}, redirects: [],
})

/** Leave the bucket in the state a successful publish of `previous` would have. */
const seedPublished = (destination, previous) => {
  for (const [path, file] of Object.entries(previous.files)) {
    destination.objects.set(objectKey(file.hash), { body: bytes(contents[path] ?? path), etag: 'seed', lastModified: 0 })
  }
  destination.objects.set(CURRENT_KEY, {
    body: bytes(JSON.stringify({ version: 1, snapshot: previous.id, updatedAt: 0 })),
    etag: 'etag-prev',
    lastModified: 0,
  })
  destination.log.length = 0
}

const headCount = (destination) => destination.log.filter((entry) => entry.method === 'HEAD').length

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
  const previous = snapshotOf(files, await computeSnapshotId(files, site, 1_700_000_000_000))
  seedPublished(destination, previous)

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
  assert.equal(outcome.buildTriggered, false)
  assert.equal(triggered, false, 'no build was started')
  assert.equal(destination.writeOrder().length, 0, 'and nothing was written')
  assert.ok(
    destination.log.every((entry) => entry.method === 'HEAD'),
    'the only traffic is confirming the site still has the files it names',
  )
})

// --- preflight: the check that used to cost a round trip per file -----------

test('a hash the live snapshot already names is not checked at all', async () => {
  // The whole point. "Checking what is already in storage" used to be one HEAD
  // per published file, for ever, so an 89-note vault paid 89 round trips to
  // publish a one-word edit. Every hash in the live snapshot was in the bucket
  // when that snapshot was committed, and nothing here removes objects, so the
  // answer is already known.
  const destination = new FakeDestination()
  const previous = snapshotOf(files)
  seedPublished(destination, previous)

  const added = { ...files, 'new.md': { hash: 'ff'.repeat(32), size: 4, mtime: 2, slug: 'new' } }
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files: added, previous, isFirstPublish: false, currentEtag: 'etag-prev' }),
      selectedPaths: new Set(Object.keys(added)),
      readFile: async () => bytes('new note'),
    }),
    () => {},
  )

  assert.equal(headCount(destination), 1, 'only the hash the site has never seen is asked about')
  assert.equal(outcome.uploaded, 1)
  assert.equal(outcome.skipped, 3, 'the three resolved locally still count as skipped')
})

test('republishing an unchanged file set makes no requests at all during preflight', async () => {
  // Same content plus one changed site setting: a real publish, so it does not
  // take the no-op exit, but there is nothing whatever to ask storage about.
  const destination = new FakeDestination()
  const previous = snapshotOf(files)
  seedPublished(destination, previous)

  await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous, isFirstPublish: false, currentEtag: 'etag-prev' }),
      site: { ...site, title: 'Renamed' },
    }),
    () => {},
  )

  assert.equal(headCount(destination), 0)
})

test('a file held at its published version is checked even when the snapshot names its hash', async () => {
  // Its bytes are gone from the vault, so a missing object there cannot be
  // uploaded, only found or lost. Preflight is the last moment at which
  // publishing the current version instead is still an option.
  const destination = new FakeDestination()
  const oldHash = '11'.repeat(32)
  const previousFiles = { ...files, 'a.md': { hash: oldHash, size: 3, mtime: 0, slug: 'a' } }
  seedPublished(destination, snapshotOf(previousFiles))
  destination.objects.delete(objectKey(oldHash))

  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous: snapshotOf(previousFiles), isFirstPublish: false, currentEtag: 'etag-prev' }),
      selection: { include: new Set(['b.md', 'img.png']), keepPrevious: new Set(['a.md']) },
    }),
    () => {},
  )

  assert.equal(outcome.committed, true)
  const snapshot = parseSnapshot(destination.text(snapshotKey(outcome.snapshotId)))
  assert.equal(snapshot.files['a.md'].hash, hashes['a.md'], "the vault's current version was published instead")
  assert.equal(destination.writeOrder().includes(objectKey(hashes['a.md'])), true)
})

test('verifyAll checks everything, because a bucket that has moved may be half copied', async () => {
  const destination = new FakeDestination()
  const previous = snapshotOf(files)
  seedPublished(destination, previous)

  await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous, isFirstPublish: false, currentEtag: 'etag-prev' }),
      site: { ...site, title: 'Renamed' },
      verifyAll: true,
    }),
    () => {},
  )

  assert.equal(headCount(destination), 3, 'nothing is taken on trust')
})

test('the skipped count is an absolute total, not doubled by a second preflight', async () => {
  // `unrecoverable` re-plans and runs preflight again. The session used to add
  // one to `skippedCount` per skip event, so the second pass counted the same
  // files over again and the log claimed twice the vault.
  const destination = new FakeDestination()
  const oldHash = '11'.repeat(32)
  const previousFiles = { ...files, 'a.md': { hash: oldHash, size: 3, mtime: 0, slug: 'a' } }
  seedPublished(destination, snapshotOf(previousFiles))
  destination.objects.delete(objectKey(oldHash))

  const session = new PublishSession({
    summary: { updates: 2, removals: 0, firstPublish: false },
    run: (onEvent) =>
      new Publisher().publish(
        baseInput(destination, {
          scan: makeScan({ files, previous: snapshotOf(previousFiles), isFirstPublish: false, currentEtag: 'etag-prev' }),
          selection: { include: new Set(['b.md', 'img.png']), keepPrevious: new Set(['a.md']) },
        }),
        onEvent,
      ),
  })
  const status = await session.finished

  assert.equal(status.state, 'done')
  assert.equal(status.outcome.skipped, 2, 'b.md and img.png were already there, once')
  assert.equal(status.progress.skippedCount, 2, 'and the log says so too')
})

test('once the live snapshot is caught naming a missing object, nothing else is taken on trust', async () => {
  // Two objects have gone from the bucket. One belongs to a file held at its
  // published version, which is checked whatever happens and forces a re-plan.
  // The other belongs to an ordinary unchanged file, whose hash the live
  // snapshot also names. Resolving that one locally on the second pass would
  // skip an upload the site actually needs, and the page would stay broken.
  const destination = new FakeDestination()
  const oldHash = '11'.repeat(32)
  const previousFiles = { ...files, 'a.md': { hash: oldHash, size: 3, mtime: 0, slug: 'a' } }
  seedPublished(destination, snapshotOf(previousFiles))
  destination.objects.delete(objectKey(oldHash))
  destination.objects.delete(objectKey(hashes['img.png']))

  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous: snapshotOf(previousFiles), isFirstPublish: false, currentEtag: 'etag-prev' }),
      selection: { include: new Set(['b.md', 'img.png']), keepPrevious: new Set(['a.md']) },
    }),
    () => {},
  )

  assert.equal(outcome.committed, true)
  assert.ok(destination.objects.has(objectKey(hashes['img.png'])), 'the other missing object was uploaded too')
  assert.equal(outcome.uploaded, 2)
})

// --- the repair path --------------------------------------------------------

test('publishing again really does repair a site whose object went missing', async () => {
  // The build stops with "Publish again from Obsidian" when the snapshot names
  // a file storage no longer has. Before this, that instruction was a dead end:
  // nothing had changed, so publishing again took the no-op exit and did
  // nothing, and editing a note did not help either.
  const destination = new FakeDestination()
  const previous = snapshotOf(files, await computeSnapshotId(files, site, 1_700_000_000_000))
  seedPublished(destination, previous)
  destination.objects.delete(objectKey(hashes['b.md']))

  let triggeredFor = null
  const outcome = await new Publisher().publish(
    baseInput(destination, {
      scan: makeScan({ files, previous, isFirstPublish: false, currentEtag: 'etag-prev' }),
      autoTrigger: true,
      builder: { id: 'x', test: async () => ({ ok: true }),
        trigger: async (id) => { triggeredFor = id; return { accepted: true } },
        waitForDeploy: async function* () { yield { state: 'live' } } },
    }),
    () => {},
  )

  assert.equal(outcome.uploaded, 1, 'the missing bytes are back')
  assert.ok(destination.objects.has(objectKey(hashes['b.md'])))
  assert.equal(outcome.buildTriggered, true)
  assert.equal(triggeredFor, previous.id, 'the build is for the snapshot that is already live')
  assert.equal(outcome.committed, false, 'nothing needed committing: the snapshot already named the right hashes')
  assert.equal(outcome.snapshotId, previous.id)
  assert.equal(destination.writeOrder().filter((key) => key === CURRENT_KEY).length, 0, 'the pointer never moves')
  assert.equal(destination.writeOrder().some((key) => key.startsWith('snapshots/')), false, 'and no new snapshot is written')
})

test('a repair with no deploy hook still puts the files back', async () => {
  const destination = new FakeDestination()
  const previous = snapshotOf(files, await computeSnapshotId(files, site, 1_700_000_000_000))
  seedPublished(destination, previous)
  destination.objects.delete(objectKey(hashes['img.png']))

  const outcome = await new Publisher().publish(
    baseInput(destination, { scan: makeScan({ files, previous, isFirstPublish: false, currentEtag: 'etag-prev' }) }),
    () => {},
  )

  assert.equal(outcome.uploaded, 1)
  assert.equal(outcome.buildTriggered, false)
  assert.equal(outcome.deploy?.kind, 'not-configured')
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

test('a degraded-path write that lands but loses its response is retried, not called a conflict', async () => {
  // The regression the pointer extraction introduced. With the retry wrapped
  // around the whole swap rather than the PUT, attempt two re-read the pointer,
  // saw its *own* snapshot there, and reported another device's publish: the
  // notes committed, the publish failed, and no build ever asked for.
  const destination = new FakeDestination({ conditionalWrites: false })
  const previous = {
    version: 1, id: 'snap-1', parent: null, createdAt: 0,
    generator: { plugin: 'open-publish', version: '0.1.0' }, site, files: {}, links: {}, redirects: [],
  }
  destination.objects.set(CURRENT_KEY, { body: bytes('{"version":1,"snapshot":"snap-1"}'), etag: 'e1', lastModified: 0 })

  let pointerPuts = 0
  const original = destination.put.bind(destination)
  destination.put = async (key, body, options) => {
    const result = await original(key, body, options)
    // The write applies, then the response is lost. An S3 500 does exactly this.
    if (key === CURRENT_KEY && ++pointerPuts === 1) throw new Error('InternalError')
    return result
  }

  const scan = makeScan({
    files: { 'c.md': { hash: 'ee'.repeat(32), size: 1, mtime: 1, slug: 'c' } },
    previous,
    isFirstPublish: false,
    currentEtag: undefined,
  })

  const outcome = await new Publisher().publish(
    baseInput(destination, { scan, selectedPaths: new Set(['c.md']), readFile: async () => bytes('c') }),
    () => {},
  )
  assert.equal(outcome.committed, true)
  assert.equal(pointerPuts, 2, 'the second attempt writes rather than re-reading and taking fright')
  assert.equal(JSON.parse(destination.text(CURRENT_KEY)).snapshot, outcome.snapshotId)
})
