/**
 * Resolved link index and embed expansion.
 *
 * Design note 2.2: raw Markdown alone is not enough. Obsidian resolves `[[Note]]`
 * against the *whole vault* — shortest-path matching, aliases, attachment
 * folders. Publish a subset and a generator cannot reproduce that, so links
 * break. The plugin already has `metadataCache`, so it emits the resolution
 * alongside the notes. Notes stay byte-identical; the intelligence travels
 * beside them.
 *
 * Obsidian types are imported as types only, so this module runs under plain
 * Node against a stub app in the tests.
 */

import type { App, TFile } from 'obsidian'
import type { SnapshotLink } from './snapshot.ts'

/** The slice of Obsidian's API this module needs — makes it testable. */
export interface LinkResolver {
  getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string; extension: string } | null
  getCache(path: string): {
    links?: Array<{ link: string; displayText?: string }>
    embeds?: Array<{ link: string; displayText?: string }>
    frontmatter?: Record<string, unknown>
    headings?: Array<{ heading: string; level: number }>
  } | null
}

export function resolverFromApp(app: App): LinkResolver {
  return {
    getFirstLinkpathDest: (linkpath, sourcePath) =>
      app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) as TFile | null,
    getCache: (path) => app.metadataCache.getCache(path) as ReturnType<LinkResolver['getCache']>,
  }
}

/** External URLs and mailto: are not vault links and must be left alone. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i
const SCHEME = /^(?:https?|mailto|obsidian|tel|ftp):/i

export function isExternalLink(link: string): boolean {
  return EXTERNAL.test(link) || SCHEME.test(link)
}

export interface ParsedLink {
  linkpath: string
  subpath?: string
}

/** Split `Note#Heading` / `Note#^block` into its parts. */
export function splitSubpath(link: string): ParsedLink {
  const hash = link.indexOf('#')
  if (hash === -1) return { linkpath: link }
  if (hash === 0) return { linkpath: '', subpath: link } // same-note link
  return { linkpath: link.slice(0, hash), subpath: link.slice(hash) }
}

/**
 * Transitive closure of `![[…]]` embeds starting from the published notes
 * (design note 2.8).
 *
 * This fixes the most common real-world failure in every subset-publishing
 * tool: a user publishes `Notes/`, their images live in a vault-level
 * `attachments/` folder outside the include rules, and the site ships with
 * broken images. Obsidian Publish handles this with a manual "Add linked"
 * button that people forget to press; we do it automatically.
 *
 * `isBlocked` lets an explicit `publish: false` still win — that is a user
 * decision, not a folder rule, and auto-inclusion must never override it.
 */
export function expandEmbeds(
  resolver: LinkResolver,
  seedPaths: Iterable<string>,
  options: {
    isSupported: (path: string) => boolean
    isBlocked: (path: string) => boolean
  },
): Set<string> {
  const included = new Set<string>(seedPaths)
  const queue = [...included]

  while (queue.length > 0) {
    const path = queue.pop() as string
    if (!path.toLowerCase().endsWith('.md')) continue // only notes have embeds

    const cache = resolver.getCache(path)
    for (const embed of cache?.embeds ?? []) {
      if (isExternalLink(embed.link)) continue
      const { linkpath } = splitSubpath(embed.link)
      if (!linkpath) continue

      const target = resolver.getFirstLinkpathDest(linkpath, path)
      if (!target) continue
      if (included.has(target.path)) continue
      if (!options.isSupported(target.path) || options.isBlocked(target.path)) continue

      included.add(target.path)
      queue.push(target.path)
    }
  }

  return included
}

/**
 * Resolve every link and embed in every published note.
 *
 * Targets that resolve but were not published are marked `unpublished` so the
 * generator can render plain text instead of a 404 — a dead-end link is a
 * worse experience than an un-linked phrase.
 */
export function buildLinkIndex(
  resolver: LinkResolver,
  publishedPaths: Set<string>,
  slugByPath: Map<string, string>,
): Record<string, SnapshotLink[]> {
  const index: Record<string, SnapshotLink[]> = {}

  for (const path of publishedPaths) {
    if (!path.toLowerCase().endsWith('.md')) continue
    const cache = resolver.getCache(path)
    if (!cache) continue

    const byRaw = new Map<string, SnapshotLink>()

    const record = (link: { link: string; displayText?: string }, embed: boolean) => {
      if (isExternalLink(link.link)) return
      const { linkpath, subpath } = splitSubpath(link.link)

      // A bare `#heading` points inside the current note; nothing to resolve.
      if (!linkpath) return

      const existing = byRaw.get(link.link)
      if (existing) {
        if (embed) existing.embed = true
        return
      }

      const target = resolver.getFirstLinkpathDest(linkpath, path)
      const targetPath = target?.path ?? null
      const status: SnapshotLink['status'] = !targetPath
        ? 'unresolved'
        : publishedPaths.has(targetPath)
          ? 'published'
          : 'unpublished'

      const entry: SnapshotLink = { raw: link.link, target: targetPath, status }
      if (status === 'published' && targetPath) {
        const slug = slugByPath.get(targetPath)
        if (slug) entry.slug = slug
      }
      if (embed) entry.embed = true
      if (subpath) entry.subpath = subpath
      if (link.displayText && link.displayText !== link.link) entry.display = link.displayText

      byRaw.set(link.link, entry)
    }

    for (const link of cache.links ?? []) record(link, false)
    for (const embed of cache.embeds ?? []) record(embed, true)

    if (byRaw.size > 0) index[path] = [...byRaw.values()]
  }

  return index
}

/** Title and aliases for the snapshot's file entries. */
export function noteMetadata(
  resolver: LinkResolver,
  path: string,
): { title?: string; aliases?: string[] } {
  const cache = resolver.getCache(path)
  const frontmatter = cache?.frontmatter ?? {}

  const rawAliases = frontmatter['aliases'] ?? frontmatter['alias']
  const aliases = Array.isArray(rawAliases)
    ? rawAliases.filter((a): a is string => typeof a === 'string')
    : typeof rawAliases === 'string'
      ? [rawAliases]
      : []

  const frontmatterTitle = typeof frontmatter['title'] === 'string' ? (frontmatter['title'] as string) : undefined
  const firstHeading = cache?.headings?.find((h) => h.level === 1)?.heading
  const fileName = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')

  const result: { title?: string; aliases?: string[] } = {
    title: frontmatterTitle ?? firstHeading ?? fileName,
  }
  if (aliases.length > 0) result.aliases = aliases
  return result
}
