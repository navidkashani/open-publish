/**
 * The one mutable write in the whole system.
 *
 * `current.json` names the snapshot the site is built from. Writing it is what
 * makes a publish visible, and it is also the entire mechanism of rollback:
 * both are the same small PUT, differing only in which manifest they name.
 *
 * That is exactly why the compare-and-swap lives here rather than in the
 * publisher. Two devices writing this key without a condition is a silently
 * lost publish, which is the worst failure this project can produce, and two
 * implementations of the guard would drift until one of them stopped guarding.
 *
 * Three routes, in order of preference:
 *
 *   1. `If-Match` on the ETag of the read this write is racing against: a real
 *      compare-and-swap, so a device that published in between wins and this
 *      write is refused.
 *   2. `If-None-Match: *` for a first publish, where the thing to guard against
 *      is not a newer version but any version at all.
 *   3. Read-then-warn, for providers without conditional writes. A lost update
 *      is possible here; corruption still is not.
 *
 * Retries and events are the caller's. `retry` wraps the PUT and *only* the
 * PUT, which is not a detail: the read-then-warn check below must happen once
 * per attempt at most. Retrying the whole route instead means a write that
 * landed but lost its response is re-read on the next attempt, seen as its own
 * snapshot, and reported as another device's publish. That is a successful
 * publish reported as a conflict, with no build triggered.
 *
 * No Obsidian import: unit tested under plain Node.
 */

import type { Destination } from '../destinations/types.ts'
import { PublishError } from './errors.ts'
import { CURRENT_KEY, parseCurrentPointer } from './snapshot.ts'

export interface PointerWriteOptions {
  /**
   * ETag of `current.json` as read by whatever decided to write it. Without
   * one there is no token to compare, so the write takes the degraded route
   * rather than becoming an unconditional overwrite dressed up as a safe one.
   */
  expectedEtag?: string
  /** Nothing has been published here yet, so the guard is "create only". */
  isFirstPublish?: boolean
  /**
   * The snapshot the pointer should still be naming. Only the degraded route
   * reads it, and only to notice that somebody else moved the pointer first.
   */
  expectedSnapshotId?: string | null
  /** Told when the provider turned out not to support conditional writes. */
  onDegraded?: (message: string) => void
  /** What to say when another device got there first. */
  conflict?: { message: string; hint?: string }
  /**
   * Wraps the PUT, and nothing else. Publishing supplies three attempts; a
   * rollback is one deliberate click and takes the default of one, reported as
   * it happened.
   */
  retry?: <T>(operation: () => Promise<T>) => Promise<T>
  now?: number
}

export const DEGRADED_MESSAGE =
  'This provider cannot do a safe swap. Checking for concurrent publishes instead.'

const DEFAULT_CONFLICT = {
  message: 'Another device changed the live version while this was running.',
  hint: 'Check what they published, then try again.',
}

/** Point the site at `snapshotId`, refusing rather than clobbering someone else. */
export async function writePointer(
  destination: Destination,
  snapshotId: string,
  options: PointerWriteOptions = {},
): Promise<void> {
  const conflict = options.conflict ?? DEFAULT_CONFLICT
  const retry = options.retry ?? ((operation) => operation())
  const now = options.now ?? Date.now()
  const pointer = JSON.stringify({ version: 1, snapshot: snapshotId, updatedAt: now })
  const body = new TextEncoder().encode(pointer).buffer as ArrayBuffer

  // A compare-and-swap needs something to compare. Support for conditional
  // writes is not enough on its own: without an ETag there is no token, and
  // writing anyway would be the exact silent lost update this path exists to
  // prevent. No token means take the degraded route, same as a provider that
  // cannot do it at all.
  const hasCompareToken = options.isFirstPublish || Boolean(options.expectedEtag)
  if (destination.supportsConditionalWrites() && hasCompareToken) {
    const put = options.isFirstPublish
      ? { ifNoneMatch: '*', contentType: 'application/json' }
      : { ifMatch: options.expectedEtag as string, contentType: 'application/json' }

    try {
      await retry(() => destination.put(CURRENT_KEY, body, put))
      return
    } catch (error) {
      if (error instanceof PublishError && error.code === 'storage-conflict') {
        throw new PublishError('storage-conflict', conflict.message, { hint: conflict.hint })
      }
      if (destination.supportsConditionalWrites()) throw error
      // The provider turned out not to support conditional writes. Fall
      // through rather than failing outright.
      options.onDegraded?.(DEGRADED_MESSAGE)
    }
  }

  // Degraded route: read the pointer again, refuse if it moved, then write.
  // This read is the only thing standing between two devices and a lost
  // update, so it must not come from a cache.
  const latest = await destination.get(CURRENT_KEY, { fresh: true })
  if (latest && !options.isFirstPublish) {
    const current = parseCurrentPointer(new TextDecoder().decode(latest))
    if (options.expectedSnapshotId && current.snapshot !== options.expectedSnapshotId) {
      throw new PublishError('storage-conflict', conflict.message, { hint: conflict.hint })
    }
  }
  await retry(() => destination.put(CURRENT_KEY, body, { contentType: 'application/json' }))
}
