/**
 * The diagnostic, diagnosed.
 *
 * It makes claims about a provider's behaviour, so the thing worth checking is
 * that it reads those behaviours correctly: a provider that ignores a
 * conditional write has to be *reported* as ignoring it, not quietly passed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { runSelfTest, SELFTEST_PREFIX } from '../src/core/selftest.ts'
import { FakeDestination } from './helpers.mjs'

const STAMP = 1_700_000_000_000
const line = (results, label) => results.find((entry) => entry.startsWith(label))

test('a correct provider passes every phase and leaves nothing behind', async () => {
  const destination = new FakeDestination()
  const results = await runSelfTest(destination, STAMP)

  assert.deepEqual(results, [
    'content-addressed write: ok',
    'deduplication check (HEAD): ok',
    'read back: ok',
    'concurrent-publish protection: ok',
    'first-publish guard: ok',
    'cleanup: ok',
  ])
  assert.deepEqual([...destination.objects.keys()], [], 'the bucket is as it was found')
})

test('every object it writes is under one prefix, so a failed run is identifiable', async () => {
  const destination = new FakeDestination()
  destination.delete = async () => {}
  await runSelfTest(destination, STAMP)
  for (const key of destination.objects.keys()) {
    assert.ok(key.startsWith(`${SELFTEST_PREFIX}/`), `${key} is outside the self-test prefix`)
  }
})

test('storage that ignores conditional writes is reported, not passed over', async () => {
  // This is the whole reason the command exists. A provider that accepts every
  // write looks perfect to any check that only asks whether writes succeed.
  const results = await runSelfTest(new FakeDestination({ conditionalWrites: false }), STAMP)
  assert.match(line(results, 'concurrent-publish'), /unavailable on this provider/)
  assert.match(line(results, 'first-publish guard'), /NOT enforced/)
})

test('the first-publish guard is checked even when compare-and-swap passes', async () => {
  // The MinIO shape: `If-Match` works, `If-None-Match: *` silently does not.
  // Every check the self-test had before this one would pass on that release.
  const destination = new FakeDestination()
  const put = destination.put.bind(destination)
  destination.put = (key, body, options = {}) => put(key, body, { ...options, ifNoneMatch: undefined })

  const results = await runSelfTest(destination, STAMP)
  assert.equal(line(results, 'concurrent-publish'), 'concurrent-publish protection: ok')
  assert.match(line(results, 'first-publish guard'), /NOT enforced/)
})

test('a leftover guard object from a crashed run does not read as a broken provider', async () => {
  const destination = new FakeDestination()
  await destination.put(`${SELFTEST_PREFIX}/first-publish-guard.json`, new ArrayBuffer(2))

  const results = await runSelfTest(destination, STAMP)
  assert.equal(line(results, 'first-publish guard'), 'first-publish guard: ok')
})

test('a token that cannot delete still gets a full report, and leaves one object per key', async () => {
  // Not hypothetical: an IAM policy without s3:DeleteObject is an easy thing to
  // write. The report has to survive it, and the leftovers must not grow by one
  // on every run.
  const destination = new FakeDestination()
  destination.delete = async () => {
    throw new Error('AccessDenied')
  }

  const first = await runSelfTest(destination, STAMP)
  assert.match(line(first, 'cleanup'), /could not remove every test object/)
  assert.equal(line(first, 'content-addressed write'), 'content-addressed write: ok', 'the earlier phases still report')

  assert.equal(line(first, 'first-publish guard'), 'first-publish guard: ok', 'and the check still runs')

  const guards = () => [...destination.objects.keys()].filter((key) => key.includes('first-publish-guard'))
  assert.equal(guards().length, 1)
  await runSelfTest(destination, STAMP + 1000)
  assert.equal(guards().length, 1, 'the guard uses a fixed key, so it cannot multiply')
})

test('a request that did not complete is never reported as a provider that lost your data', async () => {
  // "It did not throw a conflict" is not the same as "the condition was
  // ignored". A 503 on that one write must not accuse correct storage.
  const destination = new FakeDestination()
  destination.failOn = (key, method) =>
    method === 'PUT' && key.includes('first-publish-guard') ? new Error('503 Service Unavailable') : null

  const results = await runSelfTest(destination, STAMP)
  assert.match(line(results, 'first-publish guard'), /unavailable on this provider/)
  assert.doesNotMatch(line(results, 'first-publish guard'), /NOT enforced/)
})

test('leftovers from an earlier run are swept up by the next one', async () => {
  // The content-addressed object is keyed by a hash of a payload carrying the
  // run's timestamp, so it is a different key every time. Deleting only what
  // this run wrote would leave every crashed run's object there forever.
  const destination = new FakeDestination()
  await destination.put(`${SELFTEST_PREFIX}/objects/ab/abandoned`, new ArrayBuffer(4))
  await destination.put('objects/ab/real-content', new ArrayBuffer(4))

  const results = await runSelfTest(destination, STAMP)
  assert.equal(line(results, 'cleanup'), 'cleanup: ok')
  assert.deepEqual([...destination.objects.keys()], ['objects/ab/real-content'], 'and only under its own prefix')
})

test('a bucket that cannot be written to fails loudly rather than reporting a pass', async () => {
  const destination = new FakeDestination()
  destination.failOn = (_key, method) => (method === 'PUT' ? new Error('AccessDenied') : null)
  await assert.rejects(() => runSelfTest(destination, STAMP), /AccessDenied/)
})
