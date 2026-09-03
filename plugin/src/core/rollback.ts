/**
 * Site history: making a manifest that already exists live again.
 *
 * The storage design has carried this since phase 0 (design note 2.1).
 * Snapshots are immutable and objects are content-addressed, so going back to
 * an earlier version is one small PUT of `current.json` naming an older
 * manifest. Nothing downloads, nothing re-uploads, no content moves. It is the
 * identical operation that commits an ordinary publish, which is why both go
 * through `core/pointer.ts`.
 *
 * Two things make it more than that one write, and both are in here because
 * both are ways this could look correct and be wrong:
 *
 *  1. **The target's content may be gone.** Clean-up keeps the last five
 *     snapshots and a week of objects. A manifest can outlive the blobs only it
 *     referenced, and a pointer to one produces a build that 404s on every
 *     missing file: a broken deploy from a *successful* rollback, the exact
 *     failure `gc.ts` builds three guards against. So every hash is checked
 *     against one listing of `objects/` before anything is written, and a
 *     version that fails is never offered.
 *
 *  2. **A snapshot carries the site options too.** `Snapshot.site` is the
 *     config at publish time and the build reads it, `noIndex` included. Going
 *     back past the day somebody ticked "hide from search engines" un-hides
 *     their site, silently, and the person most likely to roll back is the
 *     person who just published something private. So the plan names every
 *     option that changes and flags that one.
 *
 * It goes forward as well as back: the list is whatever manifests are in the
 * bucket, including ones newer than the live pointer, so "redo" is free. That
 * is why nothing here is named after the direction.
 *
 * No Obsidian import: unit tested under plain Node.
 */

import type { Destination } from '../destinations/types.ts'
import { PublishError } from './errors.ts'
import { writePointer } from './pointer.ts'
import {
  CURRENT_KEY,
  diffFiles,
  listObjects,
  listSnapshots,
  objectKey,
  parseCurrentPointer,
  parseSnapshot,
  snapshotKey,
} from './snapshot.ts'
import type { Snapshot, SnapshotDiff, SnapshotNav, SnapshotSite, SiteBooleanKey, SiteToggleKey } from './snapshot.ts'
import { DEFAULT_LOCALE, localeLabel } from './locales.ts'

/**
 * How far back the picker goes.
 *
 * Clean-up keeps five snapshots plus a week's worth, so twenty is already well
 * past what a normal bucket holds; the cap exists for the vault that has never
 * run clean-up. Each listed version costs one GET of its manifest, and the
 * count that was truncated is reported rather than dropped, because a history
 * that quietly stops is one somebody will assume is complete.
 */
export const MAX_VERSIONS = 20

export interface SiteVersion {
  id: string
  createdAt: number
  fileCount: number
  live: boolean
  /** False when objects it references are gone. Not offered as a target. */
  restorable: boolean
  /** Why not, when `restorable` is false. Shown on the row. */
  unavailable?: string
}

export interface SiteVersionList {
  versions: SiteVersion[]
  /** How many older versions exist beyond the ones listed. */
  truncated: number
}

/** One site option whose value differs between the live version and the target. */
export interface OptionChange {
  option: string
  before: string
  after: string
  /** Worth the warning colour: this change makes the site more exposed. */
  warn?: boolean
}

export interface RollbackPlan {
  target: Snapshot
  from: string | null
  /**
   * Whether `current.json` is there at all, as opposed to there but unreadable.
   *
   * Kept apart from `from` because collapsing them breaks the recovery this
   * module promises: an interrupted write leaves a pointer that exists and does
   * not parse, and treating that as "no pointer" sends a create-only
   * `If-None-Match: *` at a key that is present, which every real provider
   * refuses. The one route out of a corrupt pointer would fail every time, and
   * say another device had published.
   */
  pointerExists: boolean
  /** What the site gains, loses and keeps. Straight from `diffFiles`. */
  diff: SnapshotDiff
  /** Site options that change, `noIndex` first. Empty when none do. */
  optionChanges: OptionChange[]
  /** Files the target names that are no longer in storage. Must be zero to run. */
  missingObjects: number
  /**
   * Whether a newer version than this one exists in storage.
   *
   * The list goes forward too, and a panel telling somebody their site shows an
   * older version after they rolled *forward* would be the same lie the naming
   * avoids. Snapshot IDs begin with a sortable timestamp, so comparing them is
   * comparing when they were published.
   */
  behind: boolean
  expectedEtag?: string
}

export interface RollbackOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
}

/**
 * Every version of the site still in storage, newest first.
 *
 * The object listing is the slow part and the reason this is cancellable: it is
 * one request, but on a large bucket it is not a fast one.
 */
export async function listSiteVersions(
  destination: Destination,
  options: RollbackOptions = {},
): Promise<SiteVersionList> {
  const { onProgress } = options
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new PublishError('aborted', 'Cancelled.')
  }

  onProgress?.('Reading the live pointer…')
  const currentId = await readLivePointer(destination)
  throwIfAborted()

  onProgress?.('Listing your site history…')
  const entries = await listSnapshots(destination)
  const listed = entries.slice(0, MAX_VERSIONS)
  throwIfAborted()

  onProgress?.('Checking what is still in storage…')
  const present = new Set((await listObjects(destination)).map((entry) => entry.key))
  throwIfAborted()

  const versions: SiteVersion[] = []
  let read = 0
  for (const entry of listed) {
    throwIfAborted()
    read++
    onProgress?.(`Reading version ${read} of ${listed.length}…`)
    versions.push(await describeVersion(destination, entry.id, entry.lastModified, currentId, present))
  }

  return { versions, truncated: entries.length - listed.length }
}

/**
 * What making `targetId` live would do, without doing any of it.
 *
 * Everything the confirm step shows comes from here, including the two things
 * that decide whether it is safe: how many of the target's files are missing
 * from storage, and which site options it would change back.
 */
export async function planRollback(
  destination: Destination,
  targetId: string,
  options: RollbackOptions = {},
): Promise<RollbackPlan> {
  const { onProgress } = options
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw new PublishError('aborted', 'Cancelled.')
  }

  onProgress?.('Reading the live pointer…')
  const pointer = await readLivePointerWithEtag(destination)
  throwIfAborted()

  if (pointer.snapshot !== null && pointer.snapshot === targetId) {
    throw new PublishError('storage-failed', 'That version is already the live one, so there is nothing to change.')
  }

  onProgress?.('Reading that version…')
  const target = await readSnapshot(destination, targetId)
  throwIfAborted()

  // A live snapshot that cannot be read costs the diff and nothing else. The
  // rollback is still correct, and refusing to explain it would be worse than
  // explaining less of it.
  const live = pointer.snapshot ? await readSnapshotOrNull(destination, pointer.snapshot) : null
  throwIfAborted()

  onProgress?.('Checking what is still in storage…')
  const present = new Set((await listObjects(destination)).map((entry) => entry.key))
  const missingObjects = countMissing(target, present)
  throwIfAborted()

  // Against the newest manifest in the bucket, not against the pointer this is
  // moving. The panel this drives claims the site is showing an older version,
  // and that claim survives a roll *forward* that does not reach the top: back
  // two steps and forward one and the site is still behind, where a comparison
  // with the live pointer would have called it a redo and cleared the panel.
  const newest = (await listSnapshots(destination))[0]?.id
  const behind = newest !== undefined && target.id < newest

  return {
    target,
    from: pointer.snapshot,
    pointerExists: pointer.exists,
    diff: diffFiles(live, target.files),
    optionChanges: live ? diffSiteOptions(live.site, target.site) : [],
    missingObjects,
    behind,
    expectedEtag: pointer.etag,
  }
}

/**
 * Commit the plan: the one small PUT.
 *
 * The missing-object check is repeated here rather than trusted from the plan,
 * because this is the last moment before a pointer names content that is not
 * there, and a clean-up can have run since the plan was made.
 */
export async function runRollback(destination: Destination, plan: RollbackPlan): Promise<void> {
  // Counted again from a fresh listing rather than read off the plan. The
  // confirm screen can sit open for minutes, and a clean-up run from another
  // device in that window is exactly how a *successful* rollback ends up
  // producing a build that 404s on every page it collected.
  const present = new Set((await listObjects(destination)).map((entry) => entry.key))
  const missing = countMissing(plan.target, present)
  if (missing > 0) {
    throw new PublishError('storage-failed', missingObjectsMessage(missing, plan.target.id), {
      hint: 'Pick a more recent version, or publish from your notes instead.',
    })
  }

  await writePointer(destination, plan.target.id, {
    expectedEtag: plan.expectedEtag,
    // Only when there is no pointer at all. Creating it back is exactly a first
    // publish, guard included: if another device recreates it first, this must
    // lose rather than overwrite. A pointer that exists but does not parse is
    // *not* this case, and sending create-only at it would refuse every time.
    isFirstPublish: !plan.pointerExists,
    expectedSnapshotId: plan.from,
    conflict: {
      message: 'The live version changed while this was being set up.',
      hint: 'Open Site history again so you can see where the site is now.',
    },
  })
}

export function missingObjectsMessage(missing: number, id: string): string {
  return (
    `${missing} file(s) from that version are no longer in storage, so making it live would build a site with ` +
    `missing pages. Version ${id} cannot be restored.`
  )
}

// --- reading ---------------------------------------------------------------

/**
 * The live pointer, read fresh.
 *
 * Same reason as `gc.ts`: this is the key whose whole purpose is to change, and
 * a cached answer here decides which version is marked live and which ETag the
 * compare-and-swap uses. Both wrong is a rollback that clobbers a publish.
 *
 * A pointer that is missing or unreadable is not an error. Someone deleted it,
 * or a write was interrupted; the version list still works and making a version
 * live is how the site comes back.
 */
async function readLivePointer(destination: Destination): Promise<string | null> {
  return (await readLivePointerWithEtag(destination)).snapshot
}

interface LivePointer {
  /** The snapshot named, or null when there is none or it cannot be read. */
  snapshot: string | null
  /** Whether the key is there, which is a different question. See `pointerExists`. */
  exists: boolean
  etag?: string
}

async function readLivePointerWithEtag(destination: Destination): Promise<LivePointer> {
  const read = destination.getWithEtag
    ? await destination.getWithEtag(CURRENT_KEY, { fresh: true })
    : await destination.get(CURRENT_KEY, { fresh: true }).then((body) => (body ? { body, etag: undefined } : null))
  if (!read) return { snapshot: null, exists: false }
  try {
    return {
      snapshot: parseCurrentPointer(new TextDecoder().decode(read.body)).snapshot,
      exists: true,
      etag: read.etag,
    }
  } catch {
    // There, and unreadable. The ETag is still a valid compare-and-swap token,
    // so this stays a guarded overwrite rather than becoming a blind one.
    return { snapshot: null, exists: true, etag: read.etag }
  }
}

/** A snapshot by ID, failing in a sentence rather than as a `SyntaxError`. */
async function readSnapshot(destination: Destination, id: string): Promise<Snapshot> {
  const body = await destination.get(snapshotKey(id))
  if (!body) {
    throw new PublishError('storage-failed', `Version ${id} is no longer in storage.`, {
      hint: 'Open Site history again to see which versions are still there.',
    })
  }
  try {
    return parseSnapshot(new TextDecoder().decode(body))
  } catch (error) {
    throw new PublishError('storage-failed', `Version ${id} could not be read. ${(error as Error).message}`, {
      hint: 'Pick a different version.',
    })
  }
}

async function readSnapshotOrNull(destination: Destination, id: string): Promise<Snapshot | null> {
  try {
    return await readSnapshot(destination, id)
  } catch {
    return null
  }
}

async function describeVersion(
  destination: Destination,
  id: string,
  lastModified: number | undefined,
  currentId: string | null,
  present: Set<string>,
): Promise<SiteVersion> {
  const base = { id, createdAt: lastModified ?? 0, fileCount: 0, live: id === currentId }
  let snapshot: Snapshot
  try {
    snapshot = await readSnapshot(destination, id)
  } catch (error) {
    return { ...base, restorable: false, unavailable: (error as Error).message }
  }

  const missing = countMissing(snapshot, present)
  return {
    ...base,
    // The manifest's own timestamp, not the object's: a bucket copied between
    // providers keeps the manifest and loses every LastModified.
    createdAt: snapshot.createdAt || base.createdAt,
    fileCount: Object.keys(snapshot.files).length,
    restorable: missing === 0,
    unavailable: missing > 0 ? `${missing} of its file(s) are no longer in storage.` : undefined,
  }
}

function countMissing(snapshot: Snapshot, present: Set<string>): number {
  const needed = new Set(Object.values(snapshot.files).map((file) => objectKey(file.hash)))
  let missing = 0
  for (const key of needed) if (!present.has(key)) missing++
  return missing
}

// --- site options ----------------------------------------------------------

/**
 * Which options a rollback would change, in the order that matters.
 *
 * `noIndex` is first and is the only one that can carry a warning, because it
 * is the only one where going back makes the site *more* exposed than the
 * person left it. Everything else is cosmetic, and is listed so that "why did
 * my title change" is never a mystery rather than because it is dangerous.
 */
export function diffSiteOptions(before: SnapshotSite, after: SnapshotSite): OptionChange[] {
  const changes: OptionChange[] = []

  if (before.noIndex !== after.noIndex) {
    changes.push({
      option: 'Hide from search engines',
      before: before.noIndex ? 'on' : 'off',
      after: after.noIndex ? 'on' : 'off',
      warn: before.noIndex && !after.noIndex,
    })
  }

  if (before.title !== after.title) {
    changes.push({ option: SPECIAL.title, before: quoted(before.title), after: quoted(after.title) })
  }
  if (before.homepage !== after.homepage) {
    changes.push({
      option: SPECIAL.homepage,
      before: before.homepage ? quoted(before.homepage) : 'a generated index',
      after: after.homepage ? quoted(after.homepage) : 'a generated index',
    })
  }

  // Defaulted on both sides rather than compared raw: a snapshot published
  // before this option existed carries no language at all, and going back to
  // one must not announce a change from the default to the default.
  const beforeLocale = before.locale ?? DEFAULT_LOCALE
  const afterLocale = after.locale ?? DEFAULT_LOCALE
  if (beforeLocale !== afterLocale) {
    changes.push({
      option: SPECIAL.locale,
      before: localeLabel(beforeLocale),
      after: localeLabel(afterLocale),
    })
  }

  for (const [key, label] of Object.entries(TOGGLES) as Array<[SiteToggleKey, string]>) {
    if (before[key] !== after[key]) {
      changes.push({ option: label, before: before[key] ? 'on' : 'off', after: after[key] ? 'on' : 'off' })
    }
  }

  // Compared as lists and reported as a count: two arrangements of the same
  // twelve pages are a real change, and a diff of two slug arrays is not
  // something anybody deciding whether to roll back can read.
  if (navKey(before.nav) !== navKey(after.nav)) {
    changes.push({ option: SPECIAL.nav, before: describeNav(before.nav), after: describeNav(after.nav) })
  }

  // Optional chaining because `parseSnapshot` validates the site block's
  // presence but not its shape, and every other read in this module fails in a
  // sentence rather than as a raw TypeError.
  if (
    before.analytics?.provider !== after.analytics?.provider ||
    before.analytics?.id !== after.analytics?.id
  ) {
    changes.push({
      option: SPECIAL.analytics,
      before: describeAnalytics(before),
      after: describeAnalytics(after),
    })
  }

  return changes
}

/**
 * The plain on/off options, and what to call each one.
 *
 * A record rather than an array, and `satisfies` rather than an annotation, so
 * that omitting a key fails to compile and adding one that is not a site option
 * does too. The array this replaced was merely *typed* as complete: a new
 * boolean option compiled fine and silently never appeared in a rollback diff.
 * Key order is insertion order, so the rendered order is still this order.
 */
const TOGGLES = {
  showThemeToggle: 'Theme toggle',
  strictLineBreaks: 'Strict line breaks',
  showNavigation: 'Navigation',
  showSearch: 'Search',
  showGraph: 'Graph view',
  showOutline: 'Table of contents',
  showBacklinks: 'Backlinks',
  showTags: 'Tags',
  showPageMetadata: 'Page metadata',
  showPrevNext: 'Previous and next links',
} satisfies Record<SiteToggleKey, string>

/**
 * Every option the loop above cannot handle, and what this file does with it.
 * `null` means deliberately not diffed.
 *
 * The other half of the same guarantee: `TOGGLES` catches a new *boolean*
 * option, this catches a new option of any other shape. Between them and the
 * `'noIndex'` named in `SiteToggleKey`, every key of `SnapshotSite` is
 * accounted for by the compiler rather than by whoever reads this next.
 */
const SPECIAL = {
  title: 'Site title',
  homepage: 'Homepage',
  locale: 'Language',
  // Derived from the language, so a change to it already shows as a Language
  // row. Listing it twice would be telling somebody the same thing twice.
  dir: null,
  nav: 'Navigation order',
  analytics: 'Analytics',
} satisfies Record<Exclude<keyof SnapshotSite, SiteBooleanKey>, string | null>

/**
 * The navigation arrangement as a sentence, because the lists themselves are
 * not readable and a diff of two slug arrays would be worse than silence.
 *
 * Counted rather than named for the same reason: what somebody rolling back
 * needs to know is that the sidebar is about to change and by roughly how much,
 * and the site itself is the place to check the detail.
 */
function describeNav(nav: SnapshotNav | undefined): string {
  const ordered = navList(nav?.order).length
  const hidden = navList(nav?.hidden).length
  if (ordered === 0 && hidden === 0) return 'the default order, nothing hidden'
  const parts: string[] = []
  if (ordered > 0) parts.push(`${ordered} ${ordered === 1 ? 'page' : 'pages'} reordered`)
  if (hidden > 0) parts.push(`${hidden} hidden`)
  return parts.join(', ')
}

function navKey(nav: SnapshotNav | undefined): string {
  return JSON.stringify([navList(nav?.order), navList(nav?.hidden)])
}

/** A snapshot's site block is cast, not validated, so neither list is trusted. */
function navList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function describeAnalytics(site: SnapshotSite): string {
  const analytics = site.analytics
  if (!analytics || analytics.provider === 'none') return 'off'
  return analytics.id ? `${analytics.provider} (${analytics.id})` : analytics.provider
}

function quoted(value: string): string {
  return `"${value}"`
}
