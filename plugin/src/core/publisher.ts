/**
 * The publish state machine.
 *
 *   IDLE -> SCANNING -> REVIEW -> PREFLIGHT -> UPLOADING -> COMMITTING
 *        -> TRIGGERING -> VERIFYING -> DONE
 *
 * The invariant that everything else exists to protect: nothing the user can
 * see changes until one small PUT of `current.json` succeeds. Every failure
 * before COMMITTING leaves the live site exactly as it was, and leaves behind
 * only orphan objects, which are harmless and deduped on the next run.
 */

import type { Destination } from '../destinations/types.ts'
import { contentTypeForPath } from '../destinations/content-types.ts'
import type { Builder } from '../builders/types.ts'
import { PublishError, toPublishError, verifyTimeoutError } from './errors.ts'
import { writePointer } from './pointer.ts'
import type { ScanResult } from './scanner.ts'
import { computeSnapshotId, objectKey, sameContent, snapshotKey } from './snapshot.ts'
import type { Snapshot, SnapshotFile, SnapshotLink } from './snapshot.ts'

export type PublishPhase =
  | 'idle'
  | 'scanning'
  | 'review'
  | 'preflight'
  | 'uploading'
  | 'committing'
  | 'triggering'
  | 'verifying'
  | 'done'
  | 'error'

/**
 * What became of the site update, as opposed to what became of the notes.
 *
 * These are separate outcomes on purpose. Once `current.json` is written the
 * notes are published, full stop; everything here is the host catching up, and
 * none of it is a reason to tell someone their publish failed.
 */
export type DeployOutcome =
  /** Asked for, still running. The notes are safe and the site is on its way. */
  | { kind: 'requested' }
  /** Confirmed: the live site is serving this snapshot. */
  | { kind: 'live' }
  /** Started, but there is no site address to poll, so we cannot say when it lands. */
  | { kind: 'unverifiable' }
  /** Automatic updates are switched off. */
  | { kind: 'auto-off' }
  /** Held back to stay inside the host's build allowance. */
  | { kind: 'throttled'; agoMinutes: number }
  /** No deploy hook has been set up yet. */
  | { kind: 'not-configured' }
  /** The host refused the request. */
  | { kind: 'rejected'; error: PublishError }
  /** Started, but the site never came back with the new snapshot. */
  | { kind: 'timeout'; logsUrl?: string }

export interface PublishEvent {
  phase: PublishPhase
  message: string
  /** Secondary line: context that should not replace the headline. */
  detail?: string
  current?: number
  total?: number
  /**
   * Running total of files already in storage, as an absolute count rather
   * than an increment. Preflight resolves most of them locally and in bulk, so
   * there is no per-file moment to count, and a re-planned second preflight
   * would otherwise add its total to the first one's.
   */
  alreadyStored?: number
  /** Per-file upload outcomes, appended as they land. */
  fileDone?: { path: string; skipped: boolean }
  /** Set once the notes are safely stored. Everything after this is the site catching up. */
  committed?: true
  /** Set whenever the site-update outcome is known or changes. */
  deploy?: DeployOutcome
  error?: PublishError
}

/**
 * What the user ticked in the review window.
 *
 * `keepPrevious` is the one that is easy to miss and the reason this is not
 * just a set of paths: unticking a *changed* file means "not this edit yet",
 * not "take this page down". Those files stay on the site at the version that
 * is already live, which works because objects are content-addressed and never
 * overwritten: the old bytes are still exactly where the old hash says.
 *
 * Anything in neither set is absent from the snapshot, and the snapshot is the
 * complete description of the site, so it comes off.
 */
export interface PublishSelection {
  /** Publish these at the version this scan found. */
  include: Set<string>
  /** Leave these on the site exactly as they are now. */
  keepPrevious: Set<string>
}

export interface PublishInput {
  scan: ScanResult
  /** What the user ticked. */
  selection?: PublishSelection
  /** Shorthand for `{ include: paths, keepPrevious: nothing }`. */
  selectedPaths?: Set<string>
  destination: Destination
  builder: Builder | null
  /** Reads the bytes of a vault file. Injected so the publisher never imports Obsidian. */
  readFile: (path: string) => Promise<ArrayBuffer>
  site: Snapshot['site']
  pluginVersion: string
  /** Build throttling. */
  autoTrigger: boolean
  minIntervalMinutes: number
  lastBuildTriggeredAt: number | null
  /**
   * Check every object rather than trusting the live snapshot to name only
   * things that are really there. Set when storage has moved: a half-copied
   * bucket is the realistic way for that assumption to be wrong.
   */
  verifyAll?: boolean
  logsUrl?: string
  verifyTimeoutMs?: number
  signal?: AbortSignal
}

export interface PublishOutcome {
  snapshotId: string
  /** False when nothing changed and we deliberately did not spend a build. */
  committed: boolean
  uploaded: number
  skipped: number
  buildTriggered: boolean
  /** How the site update went. Null only when nothing was committed. */
  deploy: DeployOutcome | null
  /** Set when the content is committed but the build did not go live. */
  deployWarning?: PublishError
}

const UPLOAD_CONCURRENCY = 4
/**
 * Higher than `UPLOAD_CONCURRENCY` on purpose: a HEAD carries no body, so the
 * bandwidth reason for keeping uploads to four does not apply. The cost of one
 * is almost entirely the SigV4 signature and the round trip.
 */
const PREFLIGHT_CONCURRENCY = 8
const UPLOAD_RETRIES = 3
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

const PREFLIGHT_MESSAGE = 'Checking what is already in storage…'
const REPAIR_DETAIL =
  'Some of your files were missing from storage, so your site could not finish building. ' +
  'Nothing in your notes has changed; this puts the missing files back.'

export class Publisher {
  /** Single-flight: a second Publish click attaches to the run already going. */
  private inFlight: Promise<PublishOutcome> | null = null

  isPublishing(): boolean {
    return this.inFlight !== null
  }

  /**
   * Start a publish, or join the one already running.
   *
   * Joining rather than queueing is deliberate: two clicks half a second apart
   * mean "publish this", not "publish it twice".
   */
  publish(input: PublishInput, onEvent: (event: PublishEvent) => void): Promise<PublishOutcome> {
    if (this.inFlight) {
      onEvent({ phase: 'uploading', message: 'A publish is already running. Following that one.' })
      return this.inFlight
    }
    const run = this.run(input, onEvent).finally(() => {
      this.inFlight = null
    })
    this.inFlight = run
    return run
  }

  private async run(input: PublishInput, onEvent: (event: PublishEvent) => void): Promise<PublishOutcome> {
    const { scan, destination, signal } = input
    const throwIfAborted = () => {
      if (signal?.aborted) throw new PublishError('aborted', 'Publish cancelled.')
    }

    if (scan.blockers.length > 0) {
      throw new PublishError('slug-collision', scan.blockers[0].message, {
        hint: 'Fix the problems listed in the publish window, then scan again.',
      })
    }

    // The snapshot the user approved may be a subset of what the scan found.
    let selection = resolveSelection(input)
    let plan = planFiles(scan.snapshot, scan.previous, selection)
    let snapshot = await buildSnapshot(scan, plan, input.site, input.pluginVersion)

    // Which hashes preflight may resolve without asking storage. See
    // `publishedHashes`; `verifyAll` empties it when storage has moved.
    let known = input.verifyAll ? new Set<string>() : publishedHashes(scan.previous)

    // A file held at its published version names an *old* hash. If that object
    // has gone missing (an over-eager clean-up, a half-migrated bucket), the
    // bytes it names exist nowhere and cannot be recreated. Uploading today's
    // bytes under yesterday's hash would poison content-addressed storage for
    // every snapshot that references it, so the only honest repair is to
    // publish the current version of that file instead.
    const republishUnrecoverable = async (paths: string[]): Promise<void> => {
      // Getting here means the live snapshot has been caught naming an object
      // that is not in storage, and that hash was in `known`. Whatever went
      // wrong could have taken others with it, so nothing is resolved locally
      // from here on: the pass that follows checks every object for real.
      known = new Set()
      selection = {
        include: new Set([...selection.include, ...paths]),
        keepPrevious: setWithout(selection.keepPrevious, paths),
      }
      plan = planFiles(scan.snapshot, scan.previous, selection)
      snapshot = await buildSnapshot(scan, plan, input.site, input.pluginVersion)
      onEvent({ phase: 'preflight', message: PREFLIGHT_MESSAGE, detail: unrecoverableDetail(paths) })
    }

    // --- no changes -> no build -------------------------------------------
    // Free-tier build allowances are small (Pages: 500/month). Burning one on a
    // no-op is pure waste. What this still has to do is confirm that "nothing
    // to do" is true, because the build refuses to run when an object the
    // snapshot names is missing and tells the reader to publish again from
    // Obsidian. Without the check below that instruction is a dead end: the
    // content has not changed, so publishing again would return right here and
    // do nothing, for ever.
    if (sameContent(snapshot, scan.previous)) {
      onEvent({ phase: 'preflight', message: PREFLIGHT_MESSAGE })
      const stored = await this.preflight(snapshot, plan.kept, new Set(), input, onEvent)
      if (stored.unrecoverable.length > 0) {
        // Nothing can put those bytes back, so the site can only be repaired by
        // publishing the vault's current version of them. That is a real change:
        // fall through to a full publish.
        await republishUnrecoverable(stored.unrecoverable)
      } else if (stored.needed.length === 0) {
        onEvent({ phase: 'done', message: 'Nothing has changed since the last publish. No build needed.' })
        return {
          snapshotId: scan.previous?.id ?? snapshot.id,
          committed: false,
          uploaded: 0,
          skipped: stored.skipped,
          buildTriggered: false,
          deploy: null,
        }
      } else {
        return await this.repair(input, scan.previous?.id ?? snapshot.id, stored, onEvent)
      }
    }

    // --- PREFLIGHT ---------------------------------------------------------
    onEvent({ phase: 'preflight', message: PREFLIGHT_MESSAGE })
    let preflight = await this.preflight(snapshot, plan.kept, known, input, onEvent)

    if (preflight.unrecoverable.length > 0) {
      await republishUnrecoverable(preflight.unrecoverable)
      preflight = await this.preflight(snapshot, plan.kept, known, input, onEvent)
    }

    const { needed, skipped } = preflight

    // --- UPLOADING ---------------------------------------------------------
    const uploaded = await this.uploadAll(input, needed, onEvent)

    throwIfAborted()

    // --- COMMITTING --------------------------------------------------------
    // Snapshot first (immutable, safe to write early), then the one mutable key.
    onEvent({ phase: 'committing', message: 'Saving your notes…' })
    const encoder = new TextEncoder()
    await withRetry(
      () =>
        destination.put(snapshotKey(snapshot.id), encoder.encode(JSON.stringify(snapshot, null, 2)).buffer as ArrayBuffer, {
          contentType: 'application/json',
        }),
      UPLOAD_RETRIES,
      signal,
    )

    await this.commitPointer(input, snapshot, onEvent)

    // Past the point of no return: the notes are published. Nothing below can
    // turn this into a failed publish, and the UI must stop offering to cancel.
    onEvent({ phase: 'committing', message: 'Your notes are saved.', committed: true })

    // --- TRIGGERING --------------------------------------------------------
    let deploy = await this.requestDeploy(input, snapshot.id, onEvent)
    const buildTriggered = deploy.kind === 'requested' || deploy.kind === 'unverifiable'
    onEvent({ phase: 'triggering', message: '', committed: true, deploy })

    // --- VERIFYING ---------------------------------------------------------
    if (deploy.kind === 'requested' && input.builder) {
      onEvent({
        phase: 'verifying',
        message: 'Your site is updating…',
        detail: 'Your notes are already saved. This is your host building and deploying them.',
        committed: true,
        deploy,
      })
      const timeoutMs = input.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
      let live = false
      for await (const state of input.builder.waitForDeploy(snapshot.id, { timeoutMs, signal })) {
        if (state.state === 'live') {
          live = true
          break
        }
        if (state.state === 'timeout') break
        // The headline stays put so this does not read as though something is
        // wrong; the churn goes in the detail line.
        onEvent({ phase: 'verifying', message: 'Your site is updating…', detail: state.detail, committed: true, deploy })
      }
      deploy = live ? { kind: 'live' } : { kind: 'timeout', logsUrl: input.logsUrl }
    }

    const deployWarning = warningFor(deploy)
    onEvent({ phase: 'done', message: 'Published.', committed: true, deploy, error: deployWarning })
    return { snapshotId: snapshot.id, committed: true, uploaded, skipped, buildTriggered, deploy, deployWarning }
  }

  /**
   * Work out which objects are missing, with as few requests as possible.
   *
   * `known` is the set of hashes we can answer for without asking storage. Every
   * hash it holds was in the bucket at the last successful publish and cannot
   * have been removed since by anything this plugin does, so a HEAD for it would
   * only ever confirm what we already know. On a typical republish that is the
   * whole vault bar a file or two, which is the difference between one request
   * per published file and one request per *changed* file.
   *
   * What is left is genuinely unknown and is checked, eight at a time. No retry:
   * a HEAD that throws is a storage failure and has to surface as one, not be
   * quietly downgraded into "missing, upload it".
   */
  private async preflight(
    snapshot: Snapshot,
    kept: Set<string>,
    known: Set<string>,
    input: PublishInput,
    onEvent: (event: PublishEvent) => void,
  ): Promise<{ needed: UploadCandidate[]; skipped: number; unrecoverable: string[] }> {
    const candidates = uploadCandidates(snapshot.files, kept)
    const toCheck: UploadCandidate[] = []
    let alreadyStored = 0

    for (const candidate of candidates) {
      // A file held at its published version is checked even when the live
      // snapshot names its hash. Its bytes are gone from the vault, so if that
      // object has vanished there is no second chance to notice: this is the
      // only moment when re-planning around it is still possible.
      if (candidate.reproducible && known.has(candidate.hash)) alreadyStored++
      else toCheck.push(candidate)
    }

    // An empty check means no bar at all, rather than a bar sitting at 100%.
    if (toCheck.length === 0) {
      onEvent({ phase: 'preflight', message: PREFLIGHT_MESSAGE, alreadyStored })
      return { needed: [], skipped: alreadyStored, unrecoverable: [] }
    }

    const present = new Array<boolean>(toCheck.length)
    let checked = 0
    let found = 0

    await runWithConcurrency(toCheck, PREFLIGHT_CONCURRENCY, async (candidate, index) => {
      if (input.signal?.aborted) throw new PublishError('aborted', 'Publish cancelled.')
      const existing = await input.destination.head(objectKey(candidate.hash))
      present[index] = existing !== null
      checked++
      if (existing) found++
      onEvent({
        phase: 'preflight',
        message: PREFLIGHT_MESSAGE,
        current: checked,
        total: toCheck.length,
        alreadyStored: alreadyStored + found,
      })
    })

    // Built here rather than in the workers so the order is the candidate order
    // whatever order the answers arrived in: `unrecoverable[0]` names a file in
    // a sentence the user reads.
    const needed: UploadCandidate[] = []
    const unrecoverable: string[] = []
    for (const [index, candidate] of toCheck.entries()) {
      if (present[index]) continue
      if (candidate.reproducible) needed.push(candidate)
      else unrecoverable.push(candidate.path)
    }

    return { needed, skipped: alreadyStored + found, unrecoverable }
  }

  /** PUT every missing object, four at a time, three attempts each. */
  private async uploadAll(
    input: PublishInput,
    needed: UploadCandidate[],
    onEvent: (event: PublishEvent) => void,
    detail?: string,
  ): Promise<number> {
    onEvent({ phase: 'uploading', message: uploadingMessage(needed.length), detail, current: 0, total: needed.length })
    let uploaded = 0

    await runWithConcurrency(needed, UPLOAD_CONCURRENCY, async (item) => {
      if (input.signal?.aborted) throw new PublishError('aborted', 'Publish cancelled.')
      const body = await input.readFile(item.path)
      await withRetry(
        () => input.destination.put(objectKey(item.hash), body, { contentType: contentTypeForPath(item.path) }),
        UPLOAD_RETRIES,
        input.signal,
      )
      uploaded++
      onEvent({
        phase: 'uploading',
        message: uploadingMessage(needed.length),
        detail,
        current: uploaded,
        total: needed.length,
        fileDone: { path: item.path, skipped: false },
      })
    })

    return uploaded
  }

  /**
   * Put back objects the live snapshot names but the bucket no longer holds.
   *
   * Nothing is committed here and no pointer is written, because neither needs
   * to be: the snapshot already names exactly the right hashes, and only the
   * bytes behind them were gone. A build is asked for, since the last one is
   * what failed and told the reader to publish again from Obsidian.
   */
  private async repair(
    input: PublishInput,
    liveSnapshotId: string,
    stored: { needed: UploadCandidate[]; skipped: number },
    onEvent: (event: PublishEvent) => void,
  ): Promise<PublishOutcome> {
    const uploaded = await this.uploadAll(input, stored.needed, onEvent, REPAIR_DETAIL)
    onEvent({ phase: 'committing', message: 'Your files are back in storage.', committed: true })

    const deploy = await this.requestDeploy(input, liveSnapshotId, onEvent)
    const buildTriggered = deploy.kind === 'requested' || deploy.kind === 'unverifiable'
    onEvent({ phase: 'triggering', message: '', committed: true, deploy })

    // No verify loop. `/_publish.json` already carries this snapshot id, which
    // is the point: the pointer never moved. Polling for it would report "live"
    // the instant it started, long before the rebuild that actually puts the
    // missing page back has finished.
    const deployWarning = warningFor(deploy)
    onEvent({ phase: 'done', message: 'Your site has everything it needs again.', committed: true, deploy, error: deployWarning })
    return { snapshotId: liveSnapshotId, committed: false, uploaded, skipped: stored.skipped, buildTriggered, deploy, deployWarning }
  }

  /** Ask the host to rebuild, or explain, in one value, why we did not. */
  private async requestDeploy(
    input: PublishInput,
    snapshotId: string,
    onEvent: (event: PublishEvent) => void,
  ): Promise<DeployOutcome> {
    if (!input.builder) return { kind: 'not-configured' }
    if (!input.autoTrigger) return { kind: 'auto-off' }

    const throttle = throttleState(input.lastBuildTriggeredAt, input.minIntervalMinutes)
    if (throttle.throttled) return { kind: 'throttled', agoMinutes: throttle.agoMinutes }

    onEvent({ phase: 'triggering', message: 'Asking your host to update the site…', committed: true })
    try {
      await input.builder.trigger(snapshotId)
    } catch (error) {
      // Content is already committed. This is a notification problem, not a
      // data problem, and the UI must say so.
      return { kind: 'rejected', error: toPublishError(error, 'Your host turned down the update request.') }
    }
    // Without a site address there is nothing to poll, so we can start a build
    // but never honestly claim it landed.
    return input.builder.canVerify?.() === false ? { kind: 'unverifiable' } : { kind: 'requested' }
  }

  /**
   * The atomic commit.
   *
   * The compare-and-swap itself lives in `core/pointer.ts`, because rollback
   * writes the same key and two copies of that guard would drift. What stays
   * here is what belongs to a publish rather than to the write: three attempts
   * at it, and the events the progress view reads.
   *
   * The retry is handed *into* the swap so that it wraps the PUT alone, which
   * is where the original had it. Wrapping the whole route instead re-runs the
   * degraded route's read-then-warn check on attempt two, where a write that
   * landed but lost its response reads back as somebody else's publish: the
   * notes are committed, the publish is reported as a conflict, and no build
   * is ever asked for. A precondition failure is a real answer rather than a
   * transient fault, so it is never retried.
   */
  private async commitPointer(
    input: PublishInput,
    snapshot: Snapshot,
    onEvent: (event: PublishEvent) => void,
  ): Promise<void> {
    const { scan } = input
    await writePointer(input.destination, snapshot.id, {
      expectedEtag: scan.currentEtag,
      isFirstPublish: scan.isFirstPublish,
      expectedSnapshotId: scan.previous?.id ?? null,
      conflict: {
        message: 'Another device published while this publish was running.',
        hint: 'Scan again so you can see their changes, then publish.',
      },
      onDegraded: (message) => onEvent({ phase: 'committing', message }),
      retry: (operation) =>
        withRetry(
          operation,
          UPLOAD_RETRIES,
          input.signal,
          (error) => error instanceof PublishError && error.code === 'storage-conflict',
        ),
    })
  }
}

// --- selection -> snapshot ------------------------------------------------

export interface FilePlan {
  files: Record<string, SnapshotFile>
  /** Paths held at their published version rather than the scanned one. */
  kept: Set<string>
}

function resolveSelection(input: PublishInput): PublishSelection {
  const selection = input.selection ?? (input.selectedPaths ? { include: input.selectedPaths, keepPrevious: new Set<string>() } : null)
  if (!selection) throw new PublishError('storage-failed', 'Nothing was selected to publish.')
  return { include: selection.include, keepPrevious: selection.keepPrevious ?? new Set<string>() }
}

/**
 * Turn the two tick sets into the file map the snapshot will carry.
 *
 * The table this implements, in one place:
 *
 *   in `include`                -> the scanned (current) version
 *   in `keepPrevious`           -> the version already on the site
 *   in neither                  -> off the site
 */
export function planFiles(full: Snapshot, previous: Snapshot | null, selection: PublishSelection): FilePlan {
  const files: Record<string, SnapshotFile> = {}
  const kept = new Set<string>()

  for (const [path, file] of Object.entries(full.files)) {
    if (selection.include.has(path)) files[path] = file
  }

  for (const path of selection.keepPrevious) {
    if (files[path]) continue
    const published = previous?.files[path]
    if (published) {
      files[path] = published
      kept.add(path)
      continue
    }
    // Asked to keep a version the site never had. There is nothing to keep, so
    // publish what the scan found rather than dropping the page.
    const scanned = full.files[path]
    if (scanned) files[path] = scanned
  }

  return { files, kept }
}

async function buildSnapshot(
  scan: { snapshot: Snapshot; previous: Snapshot | null },
  plan: FilePlan,
  site: Snapshot['site'],
  pluginVersion: string,
): Promise<Snapshot> {
  const full = scan.snapshot
  const links = resolveLinks(full, scan.previous, plan)
  const id = await computeSnapshotId(plan.files, site, full.createdAt)
  return { ...full, id, site, files: plan.files, links, generator: { plugin: 'open-publish', version: pluginVersion } }
}

/**
 * Re-point every link at the file set actually being published.
 *
 * This matters more than it looks: unticking a note must flip links pointing at
 * it from `published` to `unpublished`, or the generator emits links to pages
 * that were never built.
 */
function resolveLinks(full: Snapshot, previous: Snapshot | null, plan: FilePlan): Snapshot['links'] {
  const published = new Set(Object.keys(plan.files))
  const links: Snapshot['links'] = {}

  for (const path of published) {
    // A file held at its published version keeps that version's links. Its
    // current text is not what the site is serving, so its current links are
    // not what the site should carry.
    const source = (plan.kept.has(path) ? previous?.links[path] : undefined) ?? full.links[path]
    if (!source) continue

    links[path] = source.map((entry): SnapshotLink => {
      if (!entry.target) return entry
      const isPublished = published.has(entry.target)
      if (!isPublished) {
        if (entry.status === 'unpublished') return entry
        const next = { ...entry, status: 'unpublished' as const }
        delete next.slug
        return next
      }
      const slug = plan.files[entry.target].slug
      if (entry.status === 'published' && entry.slug === slug) return entry
      return { ...entry, status: 'published' as const, slug }
    })
  }

  return links
}

/**
 * Restrict a scanned snapshot to a flat set of paths.
 *
 * Kept as the simple case of `planFiles` for callers that only ever publish the
 * version they just scanned.
 */
export async function narrowSnapshot(
  full: Snapshot,
  selectedPaths: Set<string>,
  site: Snapshot['site'],
  pluginVersion: string,
): Promise<Snapshot> {
  const plan = planFiles(full, null, { include: selectedPaths, keepPrevious: new Set() })
  return buildSnapshot({ snapshot: full, previous: null }, plan, site, pluginVersion)
}

// --- uploads ---------------------------------------------------------------

interface UploadCandidate {
  hash: string
  path: string
  /**
   * Whether reading `path` right now yields exactly these bytes. False for a
   * file held at its published version: its hash describes content the vault no
   * longer has, so this object can never be uploaded, only found or lost.
   */
  reproducible: boolean
}

/**
 * Hashes we can say are in storage without asking.
 *
 * `previous` is the live snapshot, re-read from the bucket at the start of
 * every scan rather than remembered locally, so this is not a cache and cannot
 * go stale: every hash in it was in storage when that snapshot was committed,
 * and nothing here can have removed it since. Garbage collection is the only
 * thing that deletes, and it always keeps the current snapshot and everything
 * it references (`core/gc.ts`). Content addressing does the rest: a hash that
 * is present is the same bytes wherever it came from.
 */
function publishedHashes(previous: Snapshot | null): Set<string> {
  const hashes = new Set<string>()
  for (const file of Object.values(previous?.files ?? {})) hashes.add(file.hash)
  return hashes
}

function unrecoverableDetail(paths: string[]): string {
  return paths.length === 1
    ? `The published version of "${paths[0]}" is no longer in storage, so your current version is being published instead.`
    : `${paths.length} files are no longer in storage at their published version, so your current versions are being published instead.`
}

/** One entry per distinct content hash: identical files upload once. */
function uploadCandidates(files: Record<string, SnapshotFile>, kept: Set<string>): UploadCandidate[] {
  const byHash = new Map<string, UploadCandidate>()
  for (const [path, file] of Object.entries(files)) {
    const candidate: UploadCandidate = { hash: file.hash, path, reproducible: !kept.has(path) }
    const existing = byHash.get(file.hash)
    // Prefer a path we could actually re-upload from, if any share this hash.
    if (!existing) byHash.set(file.hash, candidate)
    else if (candidate.reproducible && !existing.reproducible) byHash.set(file.hash, candidate)
  }
  return [...byHash.values()]
}

function uploadingMessage(count: number): string {
  if (count === 0) return 'Nothing new to upload.'
  return count === 1 ? 'Uploading 1 file…' : `Uploading ${count} files…`
}

function warningFor(deploy: DeployOutcome): PublishError | undefined {
  if (deploy.kind === 'rejected') return deploy.error
  if (deploy.kind === 'timeout') return verifyTimeoutError(deploy.logsUrl)
  return undefined
}

function setWithout(source: Set<string>, remove: string[]): Set<string> {
  const out = new Set(source)
  for (const path of remove) out.delete(path)
  return out
}

export function throttleState(
  lastBuildTriggeredAt: number | null,
  minIntervalMinutes: number,
): { throttled: boolean; agoMinutes: number } {
  if (!lastBuildTriggeredAt || minIntervalMinutes <= 0) return { throttled: false, agoMinutes: 0 }
  const elapsedMs = Date.now() - lastBuildTriggeredAt
  const agoMinutes = Math.floor(elapsedMs / 60000)
  return { throttled: elapsedMs < minIntervalMinutes * 60000, agoMinutes }
}

/** The index is handed to the worker so results can be collected in order. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

async function withRetry<T>(
  operation: () => Promise<T>,
  attempts: number,
  signal?: AbortSignal,
  isFatal: (error: unknown) => boolean = () => false,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new PublishError('aborted', 'Publish cancelled.')
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (isFatal(error)) throw error
      if (error instanceof PublishError && (error.code === 'storage-credentials' || error.code === 'aborted')) throw error
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      }
    }
  }
  throw toPublishError(lastError, 'The upload failed after several attempts.')
}
