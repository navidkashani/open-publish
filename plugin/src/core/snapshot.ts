/**
 * The snapshot format and everything that reads or writes it.
 *
 * The whole atomicity story lives here (design note 2.1):
 *
 *   objects/<ab>/<sha256>        immutable, content-addressed, never overwritten
 *   snapshots/<id>.json          immutable manifest: path -> hash + metadata
 *   current.json                 the ONLY mutable key
 *
 * A publish is committed by one small PUT of current.json. Everything before
 * that is additive and safe to interrupt.
 *
 * No Obsidian import: this module is unit tested under plain Node.
 */

import { sha256Hex } from '../destinations/sigv4.ts'
import type { Destination, ListEntry } from '../destinations/types.ts'

export const SNAPSHOT_VERSION = 1
export const CURRENT_KEY = 'current.json'

export type LinkStatus = 'published' | 'unpublished' | 'unresolved'

export interface SnapshotLink {
  /** The link text exactly as written in the note, e.g. `Luhmann#Zettel|Uncle`. */
  raw: string
  /** Vault path of the resolved target, or null when nothing matched. */
  target: string | null
  /** Site slug of the target, present only when `status` is `published`. */
  slug?: string
  status: LinkStatus
  /** `![[…]]` rather than `[[…]]`. Embeds of media become images; embeds of notes stay transclusions. */
  embed?: boolean
  /** Heading or block reference after the `#`, if any. */
  subpath?: string
  /** Alias after the `|`, if any. */
  display?: string
}

export interface SnapshotFile {
  hash: string
  size: number
  mtime: number
  slug: string
  title?: string
  aliases?: string[]
}

export type AnalyticsProvider = 'none' | 'google' | 'plausible' | 'umami'

export interface SnapshotAnalytics {
  provider: AnalyticsProvider
  /** Measurement ID, domain, or site ID, depending on the provider. */
  id: string
}

/**
 * Site options: generator-agnostic *intent*, never generator specifics.
 *
 * An option earns a place here only if it changes what content is visible, who
 * can see it, or how the site looks, and only if any reasonable static site
 * generator could honour it. That rule is what lets a second starter (Astro,
 * Hugo, whatever) exist without the plugin knowing anything about it, and it is
 * why there is no capability-negotiation mechanism: there is nothing to
 * negotiate when every option is universal.
 *
 * A generator that genuinely cannot express one of these ignores it. It must
 * never guess.
 *
 * Deliberately excluded, with reasons, so this does not get relitigated:
 *   - forced light/dark default: needs patching generator internals
 *   - site description: generators derive per-page descriptions from content
 *   - readable line length, logo, nav ordering: generator-specific plumbing
 *   - stacked pages: no equivalent outside Obsidian Publish
 *   - passwords, collaborators, custom domain: server-side or host-level
 */
export interface SnapshotSite {
  title: string
  /**
   * Vault path of the note that becomes the site root, e.g. "Notes/Home.md".
   * Empty means "generate a simple index". Resolved in the plugin by giving
   * that note the slug `index`, so links and redirects stay consistent and no
   * generator needs a special case.
   */
  homepage: string
  /** Ask search engines to stay away. Not access control. See docs/security.md. */
  noIndex: boolean
  showThemeToggle: boolean
  /**
   * Markdown's own rule: a single newline is not a line break. Obsidian's
   * reading view follows it too. Turn this off and single newlines render as
   * breaks, which is what most people writing notes actually mean.
   */
  strictLineBreaks: boolean
  showNavigation: boolean
  showSearch: boolean
  showGraph: boolean
  showOutline: boolean
  showBacklinks: boolean
  showTags: boolean
  analytics: SnapshotAnalytics
}

export interface SnapshotRedirect {
  from: string
  to: string
}

export interface Snapshot {
  version: number
  id: string
  parent: string | null
  createdAt: number
  generator: { plugin: string; version: string }
  site: SnapshotSite
  files: Record<string, SnapshotFile>
  links: Record<string, SnapshotLink[]>
  redirects: SnapshotRedirect[]
}

export interface CurrentPointer {
  version: number
  snapshot: string
  updatedAt: number
}

/** Cloudflare Pages caps `_redirects` at 2,000 rules; we keep the most recent. */
export const MAX_REDIRECTS = 2000

export function objectKey(hash: string): string {
  return `objects/${hash.slice(0, 2)}/${hash}`
}

export function snapshotKey(id: string): string {
  return `snapshots/${id}.json`
}

export interface SnapshotEntry {
  id: string
  key: string
  lastModified?: number
}

/**
 * Every snapshot manifest in the bucket, newest first.
 *
 * Snapshot IDs begin with a sortable timestamp (`computeSnapshotId`), so
 * lexical order is chronological and nothing has to be opened to sort them.
 *
 * Shared, because two callers ask opposite questions of the same list:
 * garbage collection asks which snapshots are old enough to delete, and the
 * site history asks which ones are still there to go back to. Two copies of
 * "strip the prefix, strip the extension, sort" would eventually disagree
 * about what counts as a snapshot, and the one that disagreed would either
 * delete a version or hide one.
 */
export async function listSnapshots(destination: Pick<Destination, 'list'>): Promise<SnapshotEntry[]> {
  const entries = await destination.list('snapshots/')
  return entries
    .map((entry) => ({
      id: entry.key.replace(/^snapshots\//, '').replace(/\.json$/, ''),
      key: entry.key,
      lastModified: entry.lastModified,
    }))
    .filter((entry) => entry.id.length > 0)
    .sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1))
}

/**
 * Every content object in the bucket.
 *
 * One listing, never one HEAD per hash: a snapshot of a few hundred notes
 * would otherwise be a few hundred round trips. Garbage collection asks which
 * of these nothing points at; rollback asks whether everything a manifest
 * points at is still here. Same request, opposite question.
 */
export async function listObjects(destination: Pick<Destination, 'list'>): Promise<ListEntry[]> {
  return destination.list('objects/')
}

/**
 * Everything about a snapshot that decides whether the site needs rebuilding:
 * which paths exist, what content each holds, where each one lives, and the
 * site block. Deliberately not the timestamp. See `sameContent`.
 *
 * Keys are sorted all the way down so two snapshots written by different plugin
 * versions still compare equal when they describe the same site.
 */
export function snapshotContentKey(files: Record<string, SnapshotFile>, site: SnapshotSite): string {
  return JSON.stringify({
    site: sortKeysDeep(site),
    files: Object.keys(files)
      .sort()
      .map((path) => [path, files[path].hash, files[path].slug]),
  })
}

/**
 * Do these two snapshots describe the same site?
 *
 * This has to be a *content* comparison rather than an ID comparison: IDs carry
 * a timestamp prefix, so two publishes of identical content minutes apart have
 * different IDs. Comparing IDs would mean "nothing has changed" never fires
 * outside the same wall-clock second, and every no-op publish would spend a
 * build.
 */
export function sameContent(a: Snapshot | null, b: Snapshot | null): boolean {
  if (!a || !b) return false
  return snapshotContentKey(a.files, a.site) === snapshotContentKey(b.files, b.site)
}

/**
 * Snapshot IDs are `<sortable timestamp>-<6 hex of content digest>`.
 *
 * The digest covers the file set *and* the site block, so flipping a single
 * site toggle with no file changes still produces a new ID and therefore a
 * rebuild. Republishing identical content within the same second yields the
 * same ID, which is exactly what we want: retries are idempotent.
 */
export async function computeSnapshotId(
  files: Record<string, SnapshotFile>,
  site: SnapshotSite,
  createdAt: number,
): Promise<string> {
  const digest = (await sha256Hex(snapshotContentKey(files, site))).slice(0, 6)
  const timestamp = new Date(createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')
  return `${timestamp}-${digest}`
}

/**
 * When a snapshot ID says it was made, or null when it does not say.
 *
 * The inverse of the timestamp half of `computeSnapshotId`, and here beside it
 * for that reason: `2026-08-14T09-12-00Z-1a2b3c` is an ISO timestamp with its
 * colons swapped for dashes so it is safe in a key, and swapping them back is
 * the whole of it.
 *
 * Worth having because it dates a version without opening its manifest, which
 * is what lets the settings panel name the version it is talking about with no
 * network at all.
 */
export function snapshotTime(id: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(id)
  if (!match) return null
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`)
  return Number.isNaN(parsed) ? null : parsed
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key])
  return out
}

/**
 * Parse and validate a snapshot read back from storage.
 *
 * Strict on shape rather than trusting: a truncated or half-written snapshot
 * must fail here, not halfway through a build.
 */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Snapshot is not valid JSON. It may be truncated.')
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Snapshot is not an object.')
  const value = raw as Partial<Snapshot>
  if (value.version !== SNAPSHOT_VERSION) {
    throw new Error(`Unsupported snapshot version ${String(value.version)} (this plugin understands ${SNAPSHOT_VERSION}).`)
  }
  if (typeof value.id !== 'string' || !value.files || typeof value.files !== 'object') {
    throw new Error('Snapshot is missing required fields.')
  }
  if (!value.site || typeof value.site !== 'object') {
    throw new Error('Snapshot is missing its site block.')
  }
  // Every entry must carry the two fields the rest of the plugin reads without
  // checking: the hash decides what garbage collection may delete, and the slug
  // decides where the page lives. A half-written entry has to fail here rather
  // than turn into a deleted object or a broken URL.
  for (const [path, file] of Object.entries(value.files as Record<string, Partial<SnapshotFile>>)) {
    if (typeof file?.hash !== 'string' || typeof file?.slug !== 'string') {
      throw new Error(`Snapshot entry for "${path}" is incomplete.`)
    }
  }
  return {
    version: value.version,
    id: value.id,
    parent: typeof value.parent === 'string' ? value.parent : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    generator: value.generator ?? { plugin: 'unknown', version: '0' },
    site: value.site as SnapshotSite,
    files: value.files as Record<string, SnapshotFile>,
    links: (value.links as Record<string, SnapshotLink[]>) ?? {},
    redirects: Array.isArray(value.redirects) ? value.redirects : [],
  }
}

export function parseCurrentPointer(text: string): CurrentPointer {
  const raw = JSON.parse(text) as Partial<CurrentPointer>
  if (typeof raw.snapshot !== 'string') throw new Error('current.json is missing a snapshot ID.')
  return {
    version: typeof raw.version === 'number' ? raw.version : SNAPSHOT_VERSION,
    snapshot: raw.snapshot,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

export interface RenameDetection {
  redirects: SnapshotRedirect[]
  /** Vault path pairs, for display in the UI. */
  renames: Array<{ from: string; to: string }>
}

/**
 * Detect renames by diffing two snapshots (design note 2.9).
 *
 * A path that disappears while a new path appears with the *same content hash*
 * is a rename. This needs no vault events and works even if the plugin was not
 * running when the file was renamed.
 *
 * Redirects from the previous snapshot are carried forward so that a note
 * renamed twice keeps both old URLs working, and chains are collapsed
 * (a -> b -> c becomes a -> c) so no visitor takes two hops.
 */
export function detectRenames(
  previous: Snapshot | null,
  nextFiles: Record<string, SnapshotFile>,
): RenameDetection {
  if (!previous) return { redirects: [], renames: [] }

  const goneByHash = new Map<string, string[]>()
  for (const [path, file] of Object.entries(previous.files)) {
    if (nextFiles[path]) continue
    const list = goneByHash.get(file.hash)
    if (list) list.push(path)
    else goneByHash.set(file.hash, [path])
  }

  const renames: Array<{ from: string; to: string }> = []
  const slugMoves = new Map<string, string>() // old slug -> new slug

  for (const [path, file] of Object.entries(nextFiles)) {
    if (previous.files[path]) continue
    const candidates = goneByHash.get(file.hash)
    if (!candidates || candidates.length === 0) continue

    // Prefer a candidate with the same basename (a move), then take the first.
    const base = path.slice(path.lastIndexOf('/') + 1)
    const index = Math.max(0, candidates.findIndex((c) => c.slice(c.lastIndexOf('/') + 1) === base))
    const [from] = candidates.splice(index, 1)

    const oldSlug = previous.files[from].slug
    if (oldSlug && oldSlug !== file.slug) slugMoves.set(oldSlug, file.slug)
    renames.push({ from, to: path })
  }

  // A file that stayed exactly where it is but changed slug has moved its URL
  // just as surely as a renamed one, and the loop above cannot see it: that one
  // only considers paths which disappeared. Editing `permalink` is the everyday
  // way to land here, and without this the old URL 404s with nothing pointing
  // at the new one. It is also what makes changing the whole slug scheme a
  // reversible decision rather than a one-way door.
  for (const [path, file] of Object.entries(nextFiles)) {
    const before = previous.files[path]
    if (!before?.slug || before.slug === file.slug) continue
    slugMoves.set(before.slug, file.slug)
  }

  // Carry forward old redirects, re-pointing any whose target just moved.
  const merged: SnapshotRedirect[] = []
  const seen = new Set<string>()
  const push = (from: string, to: string) => {
    if (from === to || seen.has(from)) return
    seen.add(from)
    merged.push({ from, to })
  }

  for (const [from, to] of slugMoves) push(from, resolveChain(to, slugMoves))
  for (const redirect of previous.redirects) {
    push(redirect.from, resolveChain(redirect.to, slugMoves))
  }

  return { redirects: merged.slice(0, MAX_REDIRECTS), renames }
}

/** Follow `a -> b -> c` to `c`, with a hard stop so a redirect cycle cannot hang. */
function resolveChain(start: string, moves: Map<string, string>): string {
  let current = start
  for (let i = 0; i < 16; i++) {
    const next = moves.get(current)
    if (!next || next === current) break
    current = next
  }
  return current
}

export interface SnapshotDiff {
  added: string[]
  changed: string[]
  unchanged: string[]
  removed: string[]
}

/** Classify every path in the new file set against the previous snapshot. */
export function diffFiles(
  previous: Snapshot | null,
  nextFiles: Record<string, SnapshotFile>,
): SnapshotDiff {
  const diff: SnapshotDiff = { added: [], changed: [], unchanged: [], removed: [] }
  const previousFiles = previous?.files ?? {}

  for (const [path, file] of Object.entries(nextFiles)) {
    const before = previousFiles[path]
    if (!before) diff.added.push(path)
    else if (before.hash !== file.hash || before.slug !== file.slug) diff.changed.push(path)
    else diff.unchanged.push(path)
  }
  for (const path of Object.keys(previousFiles)) {
    if (!nextFiles[path]) diff.removed.push(path)
  }

  diff.added.sort()
  diff.changed.sort()
  diff.unchanged.sort()
  diff.removed.sort()
  return diff
}
