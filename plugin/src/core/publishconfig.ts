/**
 * Obsidian Publish's own configuration file, read.
 *
 * The only place in this plugin that knows the shape of `publish.json`. It is
 * a foreign format written by another program, so this mirrors
 * `migrateSettings`' defensiveness: every key is read explicitly and checked,
 * never spread, because "whatever was in the file" is not a type.
 *
 * **Nothing here is ever stored.** The import writes two arrays into
 * `selection.includes` and `selection.excludes` and stops. There is no
 * `importedFrom` field, no schema change, no `SETTINGS_VERSION` bump and
 * nothing to migrate back down, which is deliberate: a stored flag would go
 * stale the moment somebody changed their Publish folders, and the plan the
 * import shows is recomputed from the file every time anyway. `siteId` and
 * `host` are read as *evidence* (see `looksLikeObsidianPublish`) and then
 * discarded.
 *
 * `host` in particular must never reach `builder.siteUrl`. It names Obsidian's
 * internal shard, `publish-01.obsidian.md`, which nobody here owns; writing it
 * there would make `WebhookBuilder` poll a stranger's domain after every
 * publish, from a plugin whose whole pitch is that nothing passes through
 * anyone else's server.
 */

import { isAlwaysExcluded, normalizeFolderRule } from './selection.ts'

export interface PublishConfig {
  included: string[]
  excluded: string[]
  /** Evidence, never stored: it addresses a site on servers this plugin cannot reach. */
  siteId: string | null
  /** Evidence, never stored, and never a site address. See the module header. */
  host: string | null
  /** False when the file records no filter keys at all: an older Publish, or a site picked note by note. */
  hasFilters: boolean
}

export interface DroppedEntry {
  list: 'included' | 'excluded'
  raw: string
  reason: 'blank' | 'duplicate' | 'always-excluded' | 'not-a-string'
}

export type PublishConfigResult =
  | { ok: true; config: PublishConfig; dropped: DroppedEntry[] }
  | { ok: false; reason: 'unreadable' | 'not-publish-config' }

/** The keys Obsidian Publish has ever written. Any one of them makes this its file. */
const KNOWN_KEYS = ['siteId', 'host', 'included', 'excluded'] as const

/** Parse the file's text. Never throws. */
export function parsePublishConfig(raw: string): PublishConfigResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  // An array, a string, a number and `null` are all valid JSON and none of them
  // is a configuration, so they are unreadable rather than "not Publish's".
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'unreadable' }
  }

  const source = parsed as Record<string, unknown>
  if (!KNOWN_KEYS.some((key) => key in source)) return { ok: false, reason: 'not-publish-config' }

  const dropped: DroppedEntry[] = []
  return {
    ok: true,
    config: {
      included: readFolderList(source['included'], 'included', dropped),
      excluded: readFolderList(source['excluded'], 'excluded', dropped),
      siteId: readString(source['siteId']),
      host: readString(source['host']),
      // Key presence, not list length. An older Publish wrote neither key, and
      // that is a different thing from a site whose filters are empty: one has
      // no answer to give, the other answers "nothing by folder".
      hasFilters: 'included' in source || 'excluded' in source,
    },
    dropped,
  }
}

/**
 * Whether this is really a Publish site.
 *
 * Decides copy and one pre-ticked box, never whether the import is allowed, so
 * it is deliberately loose and deliberately `||` rather than `&&`: a false
 * negative costs one checkbox, and Obsidian is free to change how it names its
 * shards without telling us.
 */
export function looksLikeObsidianPublish(config: PublishConfig): boolean {
  const siteId = config.siteId !== null && /^[0-9a-f]{32}$/i.test(config.siteId)
  const host = config.host !== null && config.host.toLowerCase().endsWith('.obsidian.md')
  return siteId || host
}

/**
 * One filter list, cleaned.
 *
 * Publish stores literal folder paths here: no globs and no wildcards, which
 * is what makes the import a straight copy into rules `matchesFolderRule`
 * already understands.
 *
 * The blank check is the most important line in this file. `matchesFolderRule`
 * returns true for *every* path when the rule is empty, so a single `""`,
 * `"/"` or `"   "` in this list would publish the entire vault, which is the
 * exact accident the whole feature exists to prevent.
 */
function readFolderList(value: unknown, list: 'included' | 'excluded', dropped: DroppedEntry[]): string[] {
  if (!Array.isArray(value)) return []

  const rules: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      dropped.push({ list, raw: describe(entry), reason: 'not-a-string' })
      continue
    }
    const rule = normalizeFolderRule(entry)
    if (rule === '') {
      dropped.push({ list, raw: entry, reason: 'blank' })
      continue
    }
    // `isAlwaysExcluded` makes anything under a dot-folder unpublishable, so
    // keeping one would only produce a row reading "0 notes" nobody can explain.
    if (isAlwaysExcluded(rule)) {
      dropped.push({ list, raw: entry, reason: 'always-excluded' })
      continue
    }
    if (seen.has(rule)) {
      dropped.push({ list, raw: entry, reason: 'duplicate' })
      continue
    }
    seen.add(rule)
    rules.push(rule)
  }
  return rules
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Only ever shown back to the user in a warning, so any readable rendering will do. */
function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
