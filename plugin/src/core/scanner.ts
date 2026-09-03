/**
 * Vault scan: what would the next snapshot look like, and how does it differ
 * from what is live right now?
 *
 * The remote is always the source of truth. Every scan starts by reading
 * `current.json` from the bucket, exactly as Obsidian Publish calls its list
 * API on every scan. Local state is a hashing accelerator, never a record of
 * what is published, which is what makes publishing from a second device, or
 * from a reinstalled plugin, just work.
 */

import { TFile } from 'obsidian'
import type { App } from 'obsidian'
import type { Destination } from '../destinations/types.ts'
import { PublishError } from './errors.ts'
import { Hasher } from './hasher.ts'
import { buildLinkIndex, expandEmbeds, noteMetadata, resolverFromApp } from './linkindex.ts'
import {
  MAX_ASSET_BYTES,
  MAX_FILE_COUNT,
  MAX_UPLOAD_BYTES,
  WARN_FILE_COUNT,
  WARN_SNAPSHOT_BYTES,
  largeSnapshotWarning,
  nearFileLimitWarning,
  tooLargeToServeMessage,
  tooLargeToUploadMessage,
  tooManyFilesMessage,
} from './limits.ts'
import { migrateNavPaths, readNavHidden, readNavOrder, resolveFolderNames, resolveNav } from './navorder.ts'
import type { NavNote, NavSettings } from './navorder.ts'
import { getPublishFlag, homepageWarnings, isAlwaysExcluded, isSupportedFile } from './selection.ts'
import type { SelectionRules } from './selection.ts'
import { findSlugCollisions, legacyUrlsFor, slugForPath } from './slug.ts'
import type { UrlStyle } from './slug.ts'
import {
  CURRENT_KEY,
  computeSnapshotId,
  detectRenames,
  diffFiles,
  parseCurrentPointer,
  parseSnapshot,
  snapshotKey,
} from './snapshot.ts'
import type { Snapshot, SnapshotFile, SnapshotSite } from './snapshot.ts'

export interface ScanOptions {
  app: App
  destination: Destination
  hasher: Hasher
  rules: SelectionRules
  /**
   * The site block as settings hold it, which is not quite the block the
   * snapshot carries: its `nav` names **vault paths**, and the scan converts
   * them to slugs. `ScanResult.snapshot.site` is the converted one, and is the
   * block a publish must go on to commit.
   */
  site: SnapshotSite
  autoIncludeEmbeds: boolean
  /**
   * Not part of `site`, deliberately. The generator is told which addresses a
   * file answers at, never which scheme produced them, so this stops here and
   * only its result travels.
   */
  urlStyle: UrlStyle
  pluginVersion: string
  onProgress?: (message: string, current?: number, total?: number) => void
  signal?: AbortSignal
}

export interface ScanBlocker {
  kind: 'slug-collision' | 'too-large' | 'too-many-files'
  message: string
  paths: string[]
}

export interface ScanResult {
  /** The snapshot we would commit, before the user's checkbox choices are applied. */
  snapshot: Snapshot
  previous: Snapshot | null
  /** ETag of `current.json` at scan time, the compare-and-swap token for the commit. */
  currentEtag?: string
  /** True when there was no `current.json` at all; the commit uses If-None-Match instead. */
  isFirstPublish: boolean

  added: string[]
  changed: string[]
  unchanged: string[]
  removed: string[]
  renames: Array<{ from: string; to: string }>
  /**
   * The stored navigation with renamed notes followed, or null when nothing
   * moved. Settings are not written from here, because a scan is a question and
   * not a decision; the caller saves it. See `migrateNavPaths`.
   */
  navRenamed: NavSettings | null

  /** Auto-pulled in because a published note embeds them (design note 2.8). */
  autoIncluded: Set<string>
  /** Resolved but not published, offered by the "Add linked" button. */
  linkedButUnpublished: string[]

  /** Hard stops. A scan with blockers cannot be published. */
  blockers: ScanBlocker[]
  /** Soft warnings, shown but not blocking. */
  warnings: string[]

  totalBytes: number
}

export async function scanVault(options: ScanOptions): Promise<ScanResult> {
  const { app, destination, hasher, rules, site, onProgress } = options
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new PublishError('aborted', 'Scan cancelled.')
  }

  // 1. Remote first, always.
  onProgress?.('Reading the published snapshot…')
  const { previous, currentEtag, isFirstPublish } = await readRemoteState(destination)
  throwIfAborted()

  // 2. Resolve publish flags across the vault.
  onProgress?.('Resolving which files to publish…')
  const resolver = resolverFromApp(app)
  const allFiles = app.vault.getFiles()
  const fileByPath = new Map<string, TFile>()
  const flagByPath = new Map<string, boolean | null>()

  for (const file of allFiles) {
    if (isAlwaysExcluded(file.path) || !isSupportedFile(file.path)) continue
    fileByPath.set(file.path, file)
    const frontmatter = app.metadataCache.getCache(file.path)?.frontmatter
    flagByPath.set(file.path, getPublishFlag(file.path, frontmatter?.['publish'], rules))
  }

  const seeds = new Set<string>()
  for (const [path, flag] of flagByPath) {
    if (flag === true) seeds.add(path)
  }

  // 3. Pull in embedded attachments (and transcluded notes) transitively.
  let selected = seeds
  const autoIncluded = new Set<string>()
  if (options.autoIncludeEmbeds) {
    onProgress?.('Following embedded attachments…')
    selected = expandEmbeds(resolver, seeds, {
      isSupported: (path) => fileByPath.has(path),
      // An explicit `publish: false` still wins: that is a user decision, not a folder rule.
      isBlocked: (path) => flagByPath.get(path) === false,
    })
    for (const path of selected) {
      if (!seeds.has(path)) autoIncluded.add(path)
    }
  }
  throwIfAborted()

  // 4. Slugs, then collisions, before we spend time hashing.
  const slugByPath = new Map<string, string>()
  const homepage = site.homepage.trim()
  for (const path of selected) {
    // The homepage takes the site root. Doing this here rather than in the
    // generator means links to it, and redirects from its old name, resolve to
    // "/" automatically. No starter needs to know the concept exists.
    if (homepage && path === homepage) {
      slugByPath.set(path, 'index')
      continue
    }
    const permalink = app.metadataCache.getCache(path)?.frontmatter?.['permalink']
    slugByPath.set(path, slugForPath(path, { permalink: typeof permalink === 'string' ? permalink : undefined }))
  }

  const blockers: ScanBlocker[] = []
  const warnings: string[] = []

  /**
   * Read for the warning only. The slug loop above deliberately keeps its own
   * narrower read: it honours a string `permalink:` and nothing else, and
   * widening that here would change where notes are published rather than what
   * the author is told about it.
   */
  const declaredPermalink = (path: string): string | undefined => {
    const value = app.metadataCache.getCache(path)?.frontmatter?.['permalink']
    const first = Array.isArray(value) ? value[0] : value
    return typeof first === 'string' ? first : undefined
  }

  warnings.push(
    ...homepageWarnings(homepage, {
      exists: fileByPath.has(homepage),
      published: selected.has(homepage),
      permalink: homepage ? declaredPermalink(homepage) : undefined,
    }),
  )

  for (const collision of findSlugCollisions(slugByPath)) {
    blockers.push({
      kind: 'slug-collision',
      message:
        `${collision.paths.length} files would publish to the same URL "/${collision.slug}". ` +
        'This works on macOS and Windows but silently overwrites on the Linux build machine. ' +
        'Rename one of them, or give one a different `permalink` in frontmatter.',
      paths: collision.paths,
    })
  }

  // 5. Hash. Mostly free via Obsidian's own metadata cache.
  const files: Record<string, SnapshotFile> = {}
  const paths = [...selected].sort()
  let totalBytes = 0
  let index = 0

  for (const path of paths) {
    throwIfAborted()
    const file = fileByPath.get(path)
    if (!file) continue
    index++
    if (index % 25 === 0 || index === paths.length) onProgress?.('Hashing files…', index, paths.length)

    if (file.stat.size > MAX_UPLOAD_BYTES) {
      blockers.push({ kind: 'too-large', message: tooLargeToUploadMessage(path, file.stat.size), paths: [path] })
      continue
    }
    if (file.stat.size > MAX_ASSET_BYTES) {
      blockers.push({ kind: 'too-large', message: tooLargeToServeMessage(path, file.stat.size), paths: [path] })
      continue
    }

    const hash = await hasher.hash(file)
    const entry: SnapshotFile = {
      hash,
      size: file.stat.size,
      mtime: file.stat.mtime,
      /**
       * Both times, so a starter can date a note without inventing one. A vault
       * fetched from a snapshot is written fresh to a scratch directory with no
       * git history, so every fallback a generator has of its own collapses to
       * the moment of the build: without this, every note on the site reads as
       * created the day it was last deployed. See `SnapshotFile.ctime` for why
       * this is best effort rather than authoritative.
       */
      ctime: file.stat.ctime,
      slug: slugByPath.get(path) as string,
    }
    if (path.toLowerCase().endsWith('.md')) Object.assign(entry, noteMetadata(resolver, path))
    // Where this file used to be served, for a vault moving off Obsidian
    // Publish. A statement about the file rather than an instruction: what a
    // generator can do with an old address is the generator's business.
    const legacyUrls = legacyUrlsFor(path, entry.slug, options.urlStyle)
    if (legacyUrls) entry.legacyUrls = legacyUrls
    files[path] = entry
    totalBytes += file.stat.size
  }

  hasher.prune(new Set(fileByPath.keys()))

  // 6. Volume guards.
  const fileCount = Object.keys(files).length
  if (fileCount > MAX_FILE_COUNT) {
    blockers.push({ kind: 'too-many-files', message: tooManyFilesMessage(fileCount), paths: [] })
  } else if (fileCount > WARN_FILE_COUNT) {
    warnings.push(nearFileLimitWarning(fileCount))
  }
  if (totalBytes > WARN_SNAPSHOT_BYTES) warnings.push(largeSnapshotWarning(totalBytes))

  // 7. Link index, renames, diff.
  onProgress?.('Resolving links…')
  const publishedPaths = new Set(Object.keys(files))
  const links = buildLinkIndex(resolver, publishedPaths, slugByPath)
  const { redirects, renames } = detectRenames(previous, files)
  const diff = diffFiles(previous, files)

  const linkedButUnpublished = collectLinkedButUnpublished(links, flagByPath)

  // 8. Navigation, converted out of vault paths and into slugs.
  //
  // Here rather than in the settings panel because it needs the answers this
  // scan just worked out: which notes are published, what slug each one landed
  // on, and which of them moved since last time. It runs after `detectRenames`
  // for that last reason, so an order survives a rename instead of quietly
  // dropping the note that moved.
  const storedNav: NavSettings = site.nav ?? { order: [], hidden: [] }
  const navRenamed = migrateNavPaths(storedNav, renames, (folder) => {
    for (const path of publishedPaths) {
      if (path.startsWith(`${folder}/`)) return true
    }
    return false
  })
  const notes = navNotes(app, files)
  const nav = resolveNav(notes, navRenamed ?? storedNav)
  // What each folder is called, which is a fact about the vault rather than
  // anything anybody arranged, so it is worked out whether or not the manager
  // has ever been opened.
  const folders = resolveFolderNames(notes)
  const publishedSite: SnapshotSite = { ...site }
  // Deleted rather than left empty: a vault that has never arranged anything
  // must produce the snapshot ID it always did, or upgrading the plugin would
  // spend everybody a build on a feature nobody switched on. The same rule for
  // folder names, which a vault of lowercase hyphenated folders has none of.
  if (nav) publishedSite.nav = nav
  else delete publishedSite.nav
  if (Object.keys(folders).length > 0) publishedSite.folders = folders
  else delete publishedSite.folders

  const createdAt = Date.now()
  const id = await computeSnapshotId(files, publishedSite, createdAt)

  const snapshot: Snapshot = {
    version: 1,
    id,
    parent: previous?.id ?? null,
    createdAt,
    generator: { plugin: 'open-publish', version: options.pluginVersion },
    site: publishedSite,
    files,
    links,
    redirects,
  }

  return {
    snapshot,
    previous,
    currentEtag,
    isFirstPublish,
    added: diff.added,
    changed: diff.changed,
    unchanged: diff.unchanged,
    removed: diff.removed,
    renames,
    navRenamed,
    autoIncluded,
    linkedButUnpublished,
    blockers,
    warnings,
    totalBytes,
  }
}

/**
 * The published notes, as much of each as arranging navigation needs.
 *
 * Notes only, and that is not an oversight: a generator's sidebar is built from
 * pages, so listing every published attachment as something to put in an order
 * would offer a control that does nothing.
 */
function navNotes(app: App, files: Record<string, SnapshotFile>): NavNote[] {
  const notes: NavNote[] = []
  for (const [path, file] of Object.entries(files)) {
    if (!path.toLowerCase().endsWith('.md')) continue
    const frontmatter = app.metadataCache.getCache(path)?.frontmatter
    const order = readNavOrder(frontmatter?.['nav-order'])
    const hidden = readNavHidden(frontmatter?.['nav-hidden'])
    notes.push({
      path,
      slug: file.slug,
      title: file.title ?? file.slug.slice(file.slug.lastIndexOf('/') + 1),
      ...(order !== undefined ? { order } : {}),
      ...(hidden !== undefined ? { hidden } : {}),
    })
  }
  return notes
}

async function readRemoteState(destination: Destination): Promise<{
  previous: Snapshot | null
  currentEtag?: string
  isFirstPublish: boolean
}> {
  // `fresh` is load-bearing, not a precaution. Every diff on this screen is
  // measured against whatever this read returns, so a cached copy from before
  // the last publish reports work that is already live as still pending, and
  // then publishing it again rolls the site back to that older state.
  const fresh = { fresh: true }
  const pointerResponse = destination.getWithEtag
    ? await destination.getWithEtag(CURRENT_KEY, fresh)
    : await destination.get(CURRENT_KEY, fresh).then((body) => (body ? { body, etag: undefined } : null))

  if (!pointerResponse) return { previous: null, isFirstPublish: true }

  const pointer = parseCurrentPointer(new TextDecoder().decode(pointerResponse.body))
  const snapshotBody = await destination.get(snapshotKey(pointer.snapshot))
  if (!snapshotBody) {
    // The pointer names a snapshot that is not there. Treat the site as empty
    // rather than guessing: the next publish writes a complete snapshot anyway.
    return { previous: null, currentEtag: pointerResponse.etag, isFirstPublish: false }
  }

  return {
    previous: parseSnapshot(new TextDecoder().decode(snapshotBody)),
    currentEtag: pointerResponse.etag,
    isFirstPublish: false,
  }
}

/** Notes that published notes link to but which are not themselves published. */
function collectLinkedButUnpublished(
  links: Record<string, Array<{ target: string | null; status: string }>>,
  flagByPath: Map<string, boolean | null>,
): string[] {
  const candidates = new Set<string>()
  for (const entries of Object.values(links)) {
    for (const entry of entries) {
      if (entry.status !== 'unpublished' || !entry.target) continue
      // Never offer a note the user explicitly excluded.
      if (flagByPath.get(entry.target) === false) continue
      candidates.add(entry.target)
    }
  }
  return [...candidates].sort()
}
