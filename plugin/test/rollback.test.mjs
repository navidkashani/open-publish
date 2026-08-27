/**
 * Site history, against a fake bucket.
 *
 * Two of these are the whole reason the feature is more than one PUT, and they
 * are the two that would let it ship looking correct:
 *
 *  - a version whose objects clean-up has collected must never be offered, or a
 *    *successful* rollback produces a build that 404s on every missing file;
 *  - a snapshot carries the site options too, so going back past the day
 *    somebody ticked "hide from search engines" un-hides their site, and the
 *    person most likely to be here is the person who just published something
 *    private.
 *
 * The rest is the compare-and-swap, which is shared with publishing and is the
 * one place two devices can lose each other's work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_VERSIONS,
  diffSiteOptions,
  listSiteVersions,
  planRollback,
  runRollback,
} from '../src/core/rollback.ts'
import { CURRENT_KEY, objectKey, snapshotKey } from '../src/core/snapshot.ts'
import { PublishError } from '../src/core/errors.ts'
import { FakeDestination, bytes, site } from './helpers.mjs'

const OLD = '2026-08-14T09-12-00Z-aaaaaa'
const LIVE = '2026-08-20T11-30-00Z-bbbbbb'
const NEWER = '2026-08-25T08-00-00Z-cccccc'

const file = (hash, slug = hash) => ({ hash, size: 1, mtime: 0, slug })

function manifest(id, files, siteBlock = site) {
  return JSON.stringify({
    version: 1,
    id,
    parent: null,
    createdAt: Date.parse(`${id.slice(0, 10)}T${id.slice(11, 19).replace(/-/g, ':')}Z`),
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site: siteBlock,
    files,
    links: {},
    redirects: [],
  })
}

/**
 * A bucket. `objects` is the set of hashes that are actually still there, which
 * is deliberately separate from what the manifests reference: that gap is
 * scenario one.
 */
function seed({ snapshots, objects, current = LIVE, currentEtag = 'pointer-1', conditionalWrites = true }) {
  const destination = new FakeDestination({ conditionalWrites })
  for (const [id, { files, site: siteBlock }] of Object.entries(snapshots)) {
    destination.objects.set(snapshotKey(id), { body: bytes(manifest(id, files, siteBlock)), etag: id, lastModified: 0 })
  }
  for (const hash of objects) {
    destination.objects.set(objectKey(hash), { body: bytes(hash), etag: hash, lastModified: 0 })
  }
  if (current) {
    destination.objects.set(CURRENT_KEY, {
      body: bytes(JSON.stringify({ version: 1, snapshot: current, updatedAt: 0 })),
      etag: currentEtag,
      lastModified: 0,
    })
  }
  return destination
}

/** The commonest shape: two versions, everything both need still in storage. */
function twoVersions() {
  return seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a'), 'b.md': file('h-b-old') } },
      [LIVE]: { files: { 'a.md': file('h-a'), 'b.md': file('h-b-new'), 'secret.md': file('h-secret') } },
    },
    objects: ['h-a', 'h-b-old', 'h-b-new', 'h-secret'],
  })
}

/** Every PUT of the pointer, with the options it carried. */
function watchPointer(destination) {
  const writes = []
  const original = destination.put.bind(destination)
  destination.put = async (key, body, options) => {
    if (key === CURRENT_KEY) writes.push(options ?? {})
    return original(key, body, options)
  }
  return writes
}

const pointerSnapshot = (destination) => JSON.parse(destination.text(CURRENT_KEY)).snapshot

// --- the list --------------------------------------------------------------

test('versions come back newest first, with the live one marked', async () => {
  const { versions, truncated } = await listSiteVersions(twoVersions())

  assert.deepEqual(
    versions.map((version) => [version.id, version.live, version.fileCount]),
    [
      [LIVE, true, 3],
      [OLD, false, 2],
    ],
  )
  assert.equal(truncated, 0)
  assert.ok(versions.every((version) => version.restorable))
})

test('a version whose objects were collected is listed as unavailable, and refused as a target', async () => {
  // Clean-up kept the manifest (it is inside the retention window) and removed
  // the one object only that manifest referenced. A pointer to it would build a
  // site with a missing page, which is the failure `gc.ts` guards three ways.
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a'), 'gone.md': file('h-collected') } },
      [LIVE]: { files: { 'a.md': file('h-a') } },
    },
    objects: ['h-a'],
  })

  const { versions } = await listSiteVersions(destination)
  const old = versions.find((version) => version.id === OLD)
  assert.equal(old.restorable, false, 'it must not be offered')
  assert.match(old.unavailable, /no longer in storage/)

  const plan = await planRollback(destination, OLD)
  assert.equal(plan.missingObjects, 1)

  await assert.rejects(
    () => runRollback(destination, plan),
    (error) => error instanceof PublishError && /1 file\(s\).*no longer in storage/s.test(error.message),
  )
  assert.equal(pointerSnapshot(destination), LIVE, 'and the pointer never moved')
})

test('a newer-than-live version is offered too: this goes forward as well as back', async () => {
  const destination = seed({
    snapshots: {
      [LIVE]: { files: { 'a.md': file('h-a') } },
      [NEWER]: { files: { 'a.md': file('h-a'), 'new.md': file('h-new') } },
    },
    objects: ['h-a', 'h-new'],
  })

  const { versions } = await listSiteVersions(destination)
  const newer = versions.find((version) => version.id === NEWER)
  assert.equal(newer.restorable, true)
  assert.equal(newer.live, false)

  const plan = await planRollback(destination, NEWER)
  assert.equal(plan.behind, false, 'nothing may tell the user their site went back when it went forward')
})

test('the list is capped, and says how many it did not show', async () => {
  const snapshots = {}
  for (let i = 0; i < MAX_VERSIONS + 3; i++) {
    snapshots[`2026-08-${String(i + 1).padStart(2, '0')}T00-00-00Z-aaaaaa`] = { files: { 'a.md': file('h-a') } }
  }
  const destination = seed({ snapshots, objects: ['h-a'], current: null })

  const { versions, truncated } = await listSiteVersions(destination)
  assert.equal(versions.length, MAX_VERSIONS)
  assert.equal(truncated, 3, 'a history that quietly stops is one people assume is complete')
})

test('a corrupt manifest costs that one row, not the whole list', async () => {
  const destination = twoVersions()
  destination.objects.set(snapshotKey(OLD), { body: bytes('{ truncated'), etag: 'bad', lastModified: 0 })

  const { versions } = await listSiteVersions(destination)
  assert.equal(versions.length, 2)
  const old = versions.find((version) => version.id === OLD)
  assert.equal(old.restorable, false)
  assert.match(old.unavailable, /could not be read/)
})

test('progress is reported and the object listing is cancellable', async () => {
  const messages = []
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => listSiteVersions(twoVersions(), { signal: controller.signal, onProgress: (m) => messages.push(m) }),
    (error) => error instanceof PublishError && error.code === 'aborted',
  )
  assert.ok(messages.length > 0, 'and it says what it is doing while it does it')
})

// --- the plan --------------------------------------------------------------

test('the plan names exactly what the site gains and loses', async () => {
  const plan = await planRollback(twoVersions(), OLD)

  assert.deepEqual(plan.diff.removed, ['secret.md'], 'published since, so it comes off')
  assert.deepEqual(plan.diff.changed, ['b.md'], 'edited since, so it goes back')
  assert.deepEqual(plan.diff.unchanged, ['a.md'])
  assert.deepEqual(plan.diff.added, [], 'nothing was deleted between these two')
  assert.equal(plan.from, LIVE)
  assert.equal(plan.behind, true)
  assert.equal(plan.missingObjects, 0)
})

test('the plan names a noIndex flip from hidden to visible', async () => {
  // The worst surprise available here: somebody ticks "hide from search
  // engines", publishes, then rolls back past it and is silently un-hidden.
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a') }, site: { ...site, noIndex: false } },
      [LIVE]: { files: { 'a.md': file('h-a') }, site: { ...site, noIndex: true } },
    },
    objects: ['h-a'],
  })

  const plan = await planRollback(destination, OLD)
  const [first] = plan.optionChanges
  assert.equal(first.option, 'Hide from search engines', 'and it is named first')
  assert.equal(first.before, 'on')
  assert.equal(first.after, 'off')
  assert.equal(first.warn, true, 'this is the one that makes the site more exposed than they left it')
})

test('going the other way changes noIndex without the warning', () => {
  const changes = diffSiteOptions({ ...site, noIndex: false }, { ...site, noIndex: true })
  assert.equal(changes[0].warn, false)
})

test('the other site options are listed, so a changed title is never a mystery', () => {
  const changes = diffSiteOptions(
    { ...site, title: 'Notes', showSearch: true, analytics: { provider: 'plausible', id: 'a.test' } },
    { ...site, title: 'Old notes', showSearch: false, analytics: { provider: 'none', id: '' } },
  )
  assert.deepEqual(
    changes.map((change) => change.option),
    ['Site title', 'Search', 'Analytics'],
  )
  assert.equal(changes[0].after, '"Old notes"')
  assert.equal(changes[2].before, 'plausible (a.test)')
})

test('identical site blocks produce no option noise at all', async () => {
  const plan = await planRollback(twoVersions(), OLD)
  assert.deepEqual(plan.optionChanges, [])
})

test('making the live version live again is refused as the no-op it is', async () => {
  await assert.rejects(
    () => planRollback(twoVersions(), LIVE),
    (error) => error instanceof PublishError && /already the live one/.test(error.message),
  )
})

test('a missing target fails in a sentence, never as a SyntaxError', async () => {
  const destination = twoVersions()
  destination.objects.delete(snapshotKey(OLD))
  await assert.rejects(
    () => planRollback(destination, OLD),
    (error) => error instanceof PublishError && /no longer in storage/.test(error.message),
  )
})

test('a corrupt target fails in a sentence too', async () => {
  const destination = twoVersions()
  destination.objects.set(snapshotKey(OLD), { body: bytes('{ truncated'), etag: 'bad', lastModified: 0 })
  await assert.rejects(
    () => planRollback(destination, OLD),
    (error) =>
      error instanceof PublishError &&
      error.name !== 'SyntaxError' &&
      /could not be read.*not valid JSON/s.test(error.message),
  )
})

test('the live pointer is read fresh: a stale one names the wrong live version', async () => {
  const destination = twoVersions()
  const reads = []
  const original = destination.get.bind(destination)
  destination.get = async (key, options) => {
    reads.push({ key, fresh: options?.fresh === true })
    return original(key)
  }
  const originalWithEtag = destination.getWithEtag.bind(destination)
  destination.getWithEtag = async (key, options) => {
    reads.push({ key, fresh: options?.fresh === true })
    return originalWithEtag(key)
  }

  await planRollback(destination, OLD)
  assert.equal(reads.find((read) => read.key === CURRENT_KEY)?.fresh, true)
})

// --- the write -------------------------------------------------------------

test('the commit is a compare-and-swap on the pointer ETag it read', async () => {
  const destination = twoVersions()
  const writes = watchPointer(destination)

  const plan = await planRollback(destination, OLD)
  assert.equal(plan.expectedEtag, 'pointer-1')
  await runRollback(destination, plan)

  assert.equal(writes.length, 1)
  assert.equal(writes[0].ifMatch, 'pointer-1', 'without this, two devices decide by whichever PUT lands last')
  assert.equal(pointerSnapshot(destination), OLD)
})

test('another device published in between is refused, and the pointer is not written', async () => {
  const destination = twoVersions()
  const plan = await planRollback(destination, OLD)

  // Device B publishes while this confirm dialog is open.
  destination.objects.set(CURRENT_KEY, {
    body: bytes(JSON.stringify({ version: 1, snapshot: NEWER, updatedAt: 1 })),
    etag: 'pointer-2',
    lastModified: 1,
  })
  const writes = watchPointer(destination)

  await assert.rejects(
    () => runRollback(destination, plan),
    (error) => error instanceof PublishError && error.code === 'storage-conflict',
  )
  // The write is attempted, carrying the ETag from before device B: that *is*
  // the mechanism. Storage refuses it, which is the point.
  assert.deepEqual(
    writes.map((options) => options.ifMatch),
    ['pointer-1'],
  )
  assert.equal(pointerSnapshot(destination), NEWER, "the other device's publish is intact")
})

test('a provider without conditional writes takes the read-then-warn path', async () => {
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a') } },
      [LIVE]: { files: { 'a.md': file('h-a'), 'b.md': file('h-b') } },
    },
    objects: ['h-a', 'h-b'],
    conditionalWrites: false,
  })
  const writes = watchPointer(destination)

  const plan = await planRollback(destination, OLD)
  await runRollback(destination, plan)

  assert.equal(writes.length, 1)
  assert.equal(writes[0].ifMatch, undefined, 'there is nothing to compare on this provider')
  assert.equal(pointerSnapshot(destination), OLD)
})

test('the degraded path still notices a pointer that moved: weaker, not absent', async () => {
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a') } },
      [LIVE]: { files: { 'a.md': file('h-a') } },
      [NEWER]: { files: { 'a.md': file('h-a') } },
    },
    objects: ['h-a'],
    conditionalWrites: false,
  })
  const plan = await planRollback(destination, OLD)

  destination.objects.set(CURRENT_KEY, {
    body: bytes(JSON.stringify({ version: 1, snapshot: NEWER, updatedAt: 1 })),
    etag: 'pointer-2',
    lastModified: 1,
  })

  await assert.rejects(
    () => runRollback(destination, plan),
    (error) => error instanceof PublishError && error.code === 'storage-conflict',
  )
  assert.equal(pointerSnapshot(destination), NEWER)
})

test('a deleted pointer is not a dead end: the history still works and restores it', async () => {
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a') } },
      [LIVE]: { files: { 'a.md': file('h-a') } },
    },
    objects: ['h-a'],
    current: null,
  })

  const { versions } = await listSiteVersions(destination)
  assert.equal(versions.length, 2)
  assert.ok(versions.every((version) => !version.live), 'nothing is live when nothing points anywhere')

  const writes = watchPointer(destination)
  const plan = await planRollback(destination, LIVE)
  assert.equal(plan.from, null)
  await runRollback(destination, plan)

  // Recreating the pointer is exactly a first publish, guard included: another
  // device that recreates it first must win rather than be overwritten.
  assert.equal(writes[0].ifNoneMatch, '*')
  assert.equal(pointerSnapshot(destination), LIVE)
  assert.equal(plan.behind, false, 'restoring a deleted pointer to the newest version is not going back')
})

// --- what the review caught ------------------------------------------------

test('a pointer that exists but does not parse is repaired, not refused forever', async () => {
  // An interrupted write leaves `current.json` present and unreadable. Treating
  // that as "no pointer" sends `If-None-Match: *` at a key that is there, which
  // every real provider refuses, so the one route out of it failed every time
  // and blamed another device.
  const destination = twoVersions()
  destination.objects.set(CURRENT_KEY, { body: bytes('{ truncated'), etag: 'pointer-1', lastModified: 0 })
  const writes = watchPointer(destination)

  const plan = await planRollback(destination, OLD)
  assert.equal(plan.from, null, 'it names no snapshot, because it cannot be read')
  assert.equal(plan.pointerExists, true, 'but the key is there, which is a different question')

  await runRollback(destination, plan)
  assert.equal(writes[0].ifNoneMatch, undefined, 'create-only would be refused by the key already there')
  assert.equal(writes[0].ifMatch, 'pointer-1', 'the ETag is still a valid swap token')
  assert.equal(pointerSnapshot(destination), OLD)
})

test('a clean-up between the plan and the click is caught, not trusted away', async () => {
  // The confirm screen can sit open for minutes. `runRollback` recounts from a
  // fresh listing rather than reading the number the plan arrived with.
  const destination = twoVersions()
  const plan = await planRollback(destination, OLD)
  assert.equal(plan.missingObjects, 0, 'everything was there when the plan was made')

  destination.objects.delete(objectKey('h-b-old'))
  const writes = watchPointer(destination)

  await assert.rejects(
    () => runRollback(destination, plan),
    (error) => error instanceof PublishError && /no longer in storage/.test(error.message),
  )
  assert.equal(writes.length, 0)
  assert.equal(pointerSnapshot(destination), LIVE, 'a successful rollback must never build a site with holes')
})

test('rolling forward without reaching the top leaves the site behind, and says so', async () => {
  // Back two steps, then forward one. Comparing against the live pointer called
  // this a redo and cleared the panel while the site was still behind.
  const destination = seed({
    snapshots: {
      [OLD]: { files: { 'a.md': file('h-a') } },
      [LIVE]: { files: { 'a.md': file('h-a') } },
      [NEWER]: { files: { 'a.md': file('h-a') } },
    },
    objects: ['h-a'],
    current: OLD,
  })

  const plan = await planRollback(destination, LIVE)
  assert.equal(plan.behind, true, 'NEWER is still in storage, so the site is still showing an older version')
})

test('a site block with no analytics is diffed, not crashed through', () => {
  // `parseSnapshot` checks the site block is present, never its shape.
  const changes = diffSiteOptions({ ...site, analytics: undefined }, { ...site, title: 'Old' })
  assert.deepEqual(
    changes.map((change) => change.option),
    ['Site title', 'Analytics'],
  )
  assert.equal(changes[1].before, 'off')
})
