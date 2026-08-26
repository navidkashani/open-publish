import test from 'node:test'
import assert from 'node:assert/strict'
import { planGc, runGc, GRACE_PERIOD_MS, KEEP_SNAPSHOTS } from '../src/core/gc.ts'
import { CURRENT_KEY, objectKey, snapshotKey } from '../src/core/snapshot.ts'
import { FakeDestination, bytes, site } from './helpers.mjs'

const NOW = Date.UTC(2026, 7, 24)
const OLD = NOW - 30 * 24 * 60 * 60 * 1000
const RECENT = NOW - 60 * 1000

function seed({ snapshots, objects, current }) {
  const destination = new FakeDestination()
  for (const [id, { files, at }] of Object.entries(snapshots)) {
    const body = bytes(JSON.stringify({
      version: 1, id, parent: null, createdAt: at,
      generator: { plugin: 'open-publish', version: '0.1.0' },
      site, files, links: {}, redirects: [],
    }))
    destination.objects.set(snapshotKey(id), { body, etag: id, lastModified: at })
  }
  for (const [hash, at] of Object.entries(objects)) {
    destination.objects.set(objectKey(hash), { body: bytes(hash), etag: hash, lastModified: at })
  }
  destination.objects.set(CURRENT_KEY, { body: bytes(JSON.stringify({ version: 1, snapshot: current })), etag: 'c', lastModified: NOW })
  return destination
}

const file = (hash) => ({ hash, size: 1, mtime: 0, slug: hash })

test('objects the live snapshot needs are never deleted', async () => {
  const destination = seed({
    current: 's1',
    snapshots: { s1: { files: { 'a.md': file('live') }, at: OLD } },
    objects: { live: OLD, orphan: OLD },
  })
  const plan = await planGc({ destination, now: NOW })
  assert.deepEqual(plan.deletableObjects, [objectKey('orphan')])
})

test('recent objects are kept even when unreferenced: an in-flight build may be reading them', async () => {
  const destination = seed({
    current: 's1',
    snapshots: { s1: { files: {}, at: OLD } },
    objects: { 'just-uploaded': RECENT, 'long-orphaned': OLD },
  })
  const plan = await planGc({ destination, now: NOW })
  assert.deepEqual(plan.deletableObjects, [objectKey('long-orphaned')])
})

test('the last five snapshots are retained so rollback stays possible', async () => {
  const snapshots = {}
  const objects = {}
  for (let i = 0; i < 8; i++) {
    const id = `2026-08-0${i}T00-00-00Z-aaaaaa`
    snapshots[id] = { files: { 'a.md': file(`h${i}`) }, at: OLD }
    objects[`h${i}`] = OLD
  }
  const destination = seed({ current: '2026-08-07T00-00-00Z-aaaaaa', snapshots, objects })
  const plan = await planGc({ destination, now: NOW })

  assert.equal(plan.keptSnapshots.length, KEEP_SNAPSHOTS)
  // The three oldest snapshots go, and only their objects with them.
  assert.deepEqual(plan.deletableObjects.sort(), [objectKey('h0'), objectKey('h1'), objectKey('h2')].sort())
  assert.equal(plan.deletableSnapshots.length, 3)
})

test('an unreadable snapshot cancels the whole cleanup rather than risking live content', async () => {
  const destination = seed({ current: 's1', snapshots: { s1: { files: {}, at: OLD } }, objects: { x: OLD } })
  destination.objects.set(snapshotKey('s1'), { body: bytes('{ truncated'), etag: 'bad', lastModified: OLD })
  await assert.rejects(() => planGc({ destination, now: NOW }), /cancelled to avoid deleting live content/)
})

test('the grace period is a week', () => {
  assert.equal(GRACE_PERIOD_MS, 7 * 24 * 60 * 60 * 1000)
})

test('running the plan deletes exactly what it listed', async () => {
  const destination = seed({
    current: 's1',
    snapshots: { s1: { files: { 'a.md': file('live') }, at: OLD } },
    objects: { live: OLD, orphan: OLD },
  })
  const plan = await planGc({ destination, now: NOW })
  const deleted = await runGc(plan, destination)
  assert.equal(deleted, 1)
  assert.ok(destination.objects.has(objectKey('live')))
  assert.ok(!destination.objects.has(objectKey('orphan')))
  assert.ok(destination.objects.has(CURRENT_KEY))
})

test('the live pointer is read fresh: a stale one would delete what the site is serving', async () => {
  const reads = []
  const destination = new FakeDestination()
  const originalGet = destination.get.bind(destination)
  destination.get = async (key, options) => {
    reads.push({ key, fresh: options?.fresh === true })
    return originalGet(key)
  }
  destination.objects.set(CURRENT_KEY, { body: bytes('{"version":1,"snapshot":"s1"}'), etag: 'e', lastModified: 0 })

  await planGc({ destination, now: Date.now() })
  const pointerRead = reads.find((read) => read.key === CURRENT_KEY)
  assert.ok(pointerRead, 'the pointer is read at all')
  assert.equal(pointerRead.fresh, true)
})

test('an object whose age cannot be read is treated as new, never as expendable', () => {
  // A provider that omits LastModified would otherwise turn the grace period
  // (the thing protecting a publish already in flight) into a no-op.
  const entries = [
    { key: 'objects/ab/orphan-unknown-age', size: 1 },
    { key: 'objects/cd/orphan-old', size: 1, lastModified: OLD },
  ]
  const destination = new FakeDestination()
  destination.list = async (prefix) => entries.filter((entry) => entry.key.startsWith(prefix))

  return planGc({ destination, now: NOW }).then((plan) => {
    assert.deepEqual(plan.deletableObjects, ['objects/cd/orphan-old'])
  })
})
