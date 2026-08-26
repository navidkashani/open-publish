/**
 * What **Test connection** does, for any destination.
 *
 * Shared rather than written once per destination, because the two things it
 * proves are the two things people get wrong, and a second copy is a second
 * chance to prove one of them slightly less well. It talks to the `Destination`
 * interface and nothing else, so it never learns whether it is looking at S3 or
 * a Worker.
 */

import type { ConcurrencySupport, Destination, TestResult } from './types.ts'
import { PublishError, toPublishError } from '../core/errors.ts'

/** The same key every run, so a failed cleanup leaves one object rather than one per run. */
export const CONNECTION_TEST_KEY = '.open-publish-test'

/**
 * Round-trips a small object: PUT, GET, compare, then one conditional write,
 * then DELETE. Anything less does not actually prove the credentials have write
 * access to *this* storage.
 */
export async function runConnectionTest(destination: Destination, stamp: number): Promise<TestResult> {
  const payload = new TextEncoder().encode(`open-publish ${stamp}`)
  try {
    await destination.put(CONNECTION_TEST_KEY, payload.buffer as ArrayBuffer, { contentType: 'text/plain' })
    // The same key is reused every run, so a cached copy would be the *last*
    // run's payload, and the mismatch would be reported as "your storage is
    // broken" when the only thing wrong was the cache.
    const readBack = await destination.get(CONNECTION_TEST_KEY, { fresh: true })
    if (!readBack) {
      return { ok: false, reason: 'Wrote a test object but could not read it back.', hint: 'The token may be write-only.' }
    }
    const same = new Uint8Array(readBack).every((byte, i) => byte === payload[i])
    if (!same || readBack.byteLength !== payload.byteLength) {
      return { ok: false, reason: 'The test object read back with different contents.' }
    }
    const conditionalWrites = await probeConditionalWrites(destination, payload.buffer as ArrayBuffer)
    await destination.delete(CONNECTION_TEST_KEY)
    return { ok: true, conditionalWrites }
  } catch (error) {
    const publishError = toPublishError(error, 'The storage test failed.')
    return { ok: false, reason: publishError.message, hint: publishError.hint }
  }
}

/**
 * One write with an ETag the object cannot possibly have.
 *
 * A provider that honours `If-Match` has to refuse it. One that accepts the
 * header and ignores it writes anyway and reports success, which is the exact
 * shape of a silent lost update between two devices. Until this existed, only
 * the storage self-test could tell the difference, so **Test connection** had
 * to stay quiet about the one property people most want to know.
 *
 * Never fails the test: storage without conditional writes is weaker, not
 * broken, and the publisher already has a degraded path for it.
 *
 * Returns undefined when the probe could not run. A dropped connection or a
 * 5xx on this one request says nothing about the feature, and answering
 * "unsupported" there would tell an R2 or S3 user their storage cannot do the
 * exact thing it can, which is worse than admitting we did not find out.
 */
async function probeConditionalWrites(
  destination: Destination,
  body: ArrayBuffer,
): Promise<ConcurrencySupport | undefined> {
  const impossibleEtag = '00000000000000000000000000000000'
  try {
    await destination.put(CONNECTION_TEST_KEY, body, { contentType: 'text/plain', ifMatch: impossibleEtag })
    return 'ignored'
  } catch (error) {
    if (error instanceof PublishError && error.code === 'storage-conflict') return 'enforced'
    // The destination sets this itself, and only for the answers that actually
    // mean "not implemented". Anything else was a request that did not
    // complete, and says nothing either way.
    return destination.supportsConditionalWrites() ? undefined : 'unsupported'
  }
}
