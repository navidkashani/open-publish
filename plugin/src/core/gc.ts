/**
 * Garbage collection for orphan objects.
 *
 * Interrupted publishes leave objects nothing points at. They are harmless
 * (that is the whole point of content-addressed storage), so GC is manual
 * only, conservative, and never on the publish path.
 *
 * Three guards, because the failure mode (deleting a blob an in-flight build is
 * about to read) produces a broken deploy from a *successful* publish:
 *   1. refuses to run while a publish is in flight,
 *   2. keeps the last N snapshots and everything they reference,
 *   3. keeps any object younger than the grace period regardless of reachability.
 */

import type { Destination } from '../destinations/types.ts'
import {
  CURRENT_KEY,
  listObjects,
  listSnapshots,
  objectKey,
  parseCurrentPointer,
  parseSnapshot,
  snapshotKey,
} from './snapshot.ts'
import { formatBytes } from './limits.ts'

export const KEEP_SNAPSHOTS = 5
export const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000

export interface GcPlan {
  /** Object keys safe to delete. */
  deletableObjects: string[]
  /** Snapshot keys safe to delete. */
  deletableSnapshots: string[]
  keptSnapshots: string[]
  reclaimedBytes: number
  scannedObjects: number
}

export interface GcOptions {
  destination: Destination
  now?: number
  onProgress?: (message: string) => void
}

/** Work out what could be deleted. Deletes nothing. Call `runGc` for that. */
/**
 * An object whose age we could not read counts as new.
 *
 * Both callers are deciding what to delete, and the grace period exists to
 * protect writes that a publish in flight is about to reference. "We do not
 * know how old this is" has to mean "leave it alone", or a provider that omits
 * LastModified turns the safety net into a no-op.
 */
function withinGracePeriod(lastModified: number | undefined, now: number): boolean {
  if (lastModified === undefined) return true
  return now - lastModified < GRACE_PERIOD_MS
}

export async function planGc(options: GcOptions): Promise<GcPlan> {
  const { destination, onProgress } = options
  const now = options.now ?? Date.now()

  onProgress?.('Reading the live pointer…')
  // Of every read in the plugin this is the one that must not be stale: it
  // decides which snapshot is live, and therefore which objects are safe to
  // delete. A cached pointer here deletes the content the site is serving.
  const pointerBody = await destination.get(CURRENT_KEY, { fresh: true })
  const currentId = pointerBody ? parseCurrentPointer(new TextDecoder().decode(pointerBody)).snapshot : null

  onProgress?.('Listing snapshots…')
  const snapshotEntries = await listSnapshots(destination)

  const keep = new Set<string>()
  if (currentId) keep.add(currentId)
  for (const entry of snapshotEntries.slice(0, KEEP_SNAPSHOTS)) keep.add(entry.id)
  for (const entry of snapshotEntries) {
    if (withinGracePeriod(entry.lastModified, now)) keep.add(entry.id)
  }

  onProgress?.(`Reading ${keep.size} retained snapshot(s)…`)
  const reachable = new Set<string>()
  for (const id of keep) {
    const body = await destination.get(snapshotKey(id))
    if (!body) continue
    try {
      const snapshot = parseSnapshot(new TextDecoder().decode(body))
      for (const file of Object.values(snapshot.files)) reachable.add(objectKey(file.hash))
    } catch {
      // An unreadable snapshot is exactly when to be careful: treat it as
      // retaining everything by bailing out of GC entirely.
      throw new Error(`Snapshot ${id} could not be read, so garbage collection was cancelled to avoid deleting live content.`)
    }
  }

  onProgress?.('Listing objects…')
  const objects = await listObjects(destination)

  const deletableObjects: string[] = []
  let reclaimedBytes = 0
  for (const entry of objects) {
    if (reachable.has(entry.key)) continue
    if (withinGracePeriod(entry.lastModified, now)) continue
    deletableObjects.push(entry.key)
    reclaimedBytes += entry.size
  }

  const deletableSnapshots = snapshotEntries.filter((entry) => !keep.has(entry.id)).map((entry) => entry.key)

  return {
    deletableObjects,
    deletableSnapshots,
    keptSnapshots: [...keep].sort().reverse(),
    reclaimedBytes,
    scannedObjects: objects.length,
  }
}

export async function runGc(
  plan: GcPlan,
  destination: Destination,
  onProgress?: (message: string, current: number, total: number) => void,
): Promise<number> {
  const keys = [...plan.deletableObjects, ...plan.deletableSnapshots]
  let deleted = 0
  for (const key of keys) {
    await destination.delete(key)
    deleted++
    onProgress?.(`Deleting unreferenced objects…`, deleted, keys.length)
  }
  return deleted
}

export function describeGcPlan(plan: GcPlan): string {
  if (plan.deletableObjects.length === 0 && plan.deletableSnapshots.length === 0) {
    return `Nothing to clean up. ${plan.scannedObjects} object(s) are all referenced or too recent to touch.`
  }
  return (
    `${plan.deletableObjects.length} unreferenced object(s) and ${plan.deletableSnapshots.length} old snapshot(s) ` +
    `can be removed, reclaiming about ${formatBytes(plan.reclaimedBytes)}. ` +
    `Keeping the ${plan.keptSnapshots.length} most recent snapshot(s) and anything published in the last 7 days.`
  )
}
