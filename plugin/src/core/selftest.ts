/**
 * Proves the properties the atomic design rests on, without touching the live
 * site: content-addressed writes, deduplication by hash, and the two
 * conditional writes that stop one device clobbering another.
 *
 * Lives here rather than in `main.ts` so it can be run against a fake
 * destination. It was the one thing in the plugin making claims about a
 * provider's behaviour with nothing checking that it read those claims
 * correctly, which for a diagnostic is the wrong way round.
 *
 * Returns lines rather than showing them: the caller owns the Notice.
 */

import type { Destination } from '../destinations/types.ts'
import { PublishError } from './errors.ts'
import { CURRENT_KEY, objectKey } from './snapshot.ts'

export const SELFTEST_PREFIX = '_selftest'

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer

export async function runSelfTest(destination: Destination, stamp: number): Promise<string[]> {
  const results: string[] = []
  const payload = bytes(`open-publish self-test ${stamp}`)

  const digest = await crypto.subtle.digest('SHA-256', payload)
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = `${SELFTEST_PREFIX}/${objectKey(hash)}`

  await destination.put(key, payload)
  results.push('content-addressed write: ok')

  // The whole point of this command is to observe the bucket, so nothing here
  // may be answered from a cache.
  const head = await destination.head(key, { fresh: true })
  if (!head) throw new Error('The object could not be found after writing it.')
  results.push('deduplication check (HEAD): ok')

  const roundTrip = await destination.get(key, { fresh: true })
  if (!roundTrip || roundTrip.byteLength !== payload.byteLength) {
    throw new Error('The object read back with the wrong length.')
  }
  results.push('read back: ok')

  const pointerKey = `${SELFTEST_PREFIX}/${CURRENT_KEY}`
  const guardKey = `${SELFTEST_PREFIX}/first-publish-guard.json`
  results.push(await checkCompareAndSwap(destination, pointerKey))
  results.push(await checkFirstPublishGuard(destination, guardKey))
  results.push(await cleanUp(destination, [key, pointerKey, guardKey]))

  return results
}

/**
 * Sweep the whole prefix rather than the three keys this run knows about.
 *
 * The content-addressed object is keyed by the hash of a payload that carries
 * the run's timestamp, so it is a *different* key every time. Deleting only
 * what this run wrote would leave anything a crashed or interrupted run left
 * behind, one more object each time, with nothing that ever collects them.
 * Listing is the only way to find those, and this is a maintenance command
 * where one extra request costs nothing.
 */
async function keysToRemove(destination: Destination, written: readonly string[]): Promise<readonly string[]> {
  try {
    const listed = await destination.list(`${SELFTEST_PREFIX}/`)
    return [...new Set([...written, ...listed.map((entry) => entry.key)])]
  } catch {
    // A token without list access can still delete what it just wrote.
    return written
  }
}

/**
 * Compare-and-swap: write a pointer, then try to overwrite it with a stale
 * ETag. A correct provider must reject the second write. This is what protects
 * every publish after the first.
 */
async function checkCompareAndSwap(destination: Destination, pointerKey: string): Promise<string> {
  try {
    const first = await destination.put(pointerKey, bytes('{"v":1}'), { contentType: 'application/json' })
    // A provider that turns out not to support conditional writes throws here.
    // That is a finding to report, not a reason to abandon the run: the checks
    // above it already passed and deserve to be shown.
    if (!first.etag || !destination.supportsConditionalWrites()) {
      throw new PublishError('storage-failed', 'no conditional-write support')
    }
    await destination.put(pointerKey, bytes('{"v":2}'), {
      contentType: 'application/json',
      ifMatch: first.etag,
    })
    const stale = await attempt(() =>
      destination.put(pointerKey, bytes('{"v":3}'), {
        contentType: 'application/json',
        ifMatch: first.etag, // deliberately stale now
      }),
    )
    if (stale === 'failed') return 'concurrent-publish protection: could not be checked, the request did not complete'
    return stale === 'refused'
      ? 'concurrent-publish protection: ok'
      : 'concurrent-publish protection: NOT enforced. This provider ignores conditional writes, so two devices publishing at once could overwrite each other'
  } catch {
    return 'concurrent-publish protection: unavailable on this provider'
  }
}

/**
 * The *other* conditional write, and the one nothing else exercised.
 *
 * `publisher.ts` uses `If-None-Match: *` on the first publish, where it is the
 * only thing stopping a second device's first publish landing on top of the
 * first one's. MinIO shipped a release where the second such write succeeded
 * instead of returning 412, so a provider can pass every check above and still
 * fail here.
 *
 * A fixed key, cleared first rather than made unique per run. A unique key is
 * only ever tidied up if DELETE succeeds, so a token scoped without
 * `s3:DeleteObject` would leave one more object behind on every run, forever.
 * This way a failed cleanup leaves exactly one.
 *
 * The clear is best effort, and a key that survives it is not a problem: a
 * write refused *because the key is already there* is the very property being
 * tested, so it counts as a pass rather than as a broken provider.
 */
async function checkFirstPublishGuard(destination: Destination, guardKey: string): Promise<string> {
  const write = (): Promise<unknown> =>
    destination.put(guardKey, bytes('{"v":1}'), { contentType: 'application/json', ifNoneMatch: '*' })
  try {
    await destination.delete(guardKey)
  } catch {
    // A token without delete access can still run the check below.
  }

  for (const outcome of [await attempt(write), await attempt(write)]) {
    if (outcome === 'refused') return 'first-publish guard: ok'
    if (outcome === 'failed') return 'first-publish guard: unavailable on this provider'
  }
  return 'first-publish guard: NOT enforced. Two devices publishing for the first time at once could overwrite each other'
}

/**
 * One try per key, not one around all of them: the objects are written before
 * any of the checks that can fail, and a single failing delete must not skip
 * the deletes after it.
 */
async function cleanUp(destination: Destination, written: readonly string[]): Promise<string> {
  let allGone = true
  for (const key of await keysToRemove(destination, written)) {
    try {
      await destination.delete(key)
    } catch {
      allGone = false
    }
  }
  return allGone
    ? 'cleanup: ok'
    : `cleanup: could not remove every test object. They are harmless, and all under ${SELFTEST_PREFIX}/`
}

/**
 * How a conditional write ended, in three answers rather than two.
 *
 * "It did not throw a conflict" is not the same as "the provider ignored the
 * condition": a dropped connection or a 503 on that request throws neither.
 * Collapsing the two is how a diagnostic ends up accusing correct storage of
 * losing people's publishes.
 */
type WriteOutcome = 'refused' | 'accepted' | 'failed'

async function attempt(write: () => Promise<unknown>): Promise<WriteOutcome> {
  try {
    await write()
    return 'accepted'
  } catch (error) {
    if (error instanceof PublishError && error.code === 'storage-conflict') return 'refused'
    return 'failed'
  }
}
