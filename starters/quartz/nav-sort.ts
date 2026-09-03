/**
 * The navigation from the snapshot, as the three functions Quartz's explorer
 * wants: what order the sidebar is in, what is left out of it, and what each
 * folder is called.
 *
 * The one constraint that shapes every line of this file: **the functions must
 * survive being turned into a string and back again.** `Explorer.tsx` writes
 * them into a `data-data-fns` attribute with `.toString()`, and
 * `scripts/explorer.inline.ts` rebuilds them in the browser with
 * `new Function("return " + src)()`. A closure over an outer variable stringifies
 * to source that mentions a name nothing in the browser has ever bound, so it
 * throws on the first comparison and the sidebar renders unsorted with no error
 * anybody sees. So these are built with `new Function` and the data they need is
 * embedded in their own source as a JSON literal.
 *
 * That round trip is exactly what `scripts/nav-sort.test.mjs` performs, because
 * it is the only failure here that a normal unit test would miss.
 *
 * Quartz is deliberately not imported. This file describes the handful of
 * properties it reads off a node and nothing else, which keeps it loadable by
 * `node --test` under type stripping, with no Quartz checkout in the way.
 */

/** As much of Quartz's `FileTrieNode` as sorting, filtering and renaming touch. */
export interface NavSortNode {
  slug: string
  slugSegment: string
  displayName: string
  isFolder: boolean
}

export interface NavConfig {
  /** Slugs in sidebar order, for the parents somebody arranged. */
  order?: readonly string[]
  /** Slugs to leave out of the sidebar. Still built, still reachable. */
  hidden?: readonly string[]
}

export interface NavExplorerOptions {
  sortFn: (a: NavSortNode, b: NavSortNode) => number
  filterFn: (node: NavSortNode) => boolean
  mapFn?: (node: NavSortNode) => void
}

/**
 * The options to hand `Component.Explorer()`, or undefined when there is
 * nothing to say.
 *
 * Undefined rather than options that happen to be no-ops, because
 * `Component.Explorer(undefined)` is the same call as `Component.Explorer()`
 * down to the rendered byte. A site nobody has arranged keeps exactly the HTML
 * it had before this feature existed.
 */
export function navExplorerOptions(
  nav: NavConfig | undefined,
  /** `site.folders`: what to call a folder Quartz would otherwise call by its slug. */
  folders: Record<string, string> = {},
): NavExplorerOptions | undefined {
  const order = nav?.order ?? []
  const hidden = nav?.hidden ?? []
  const named = Object.keys(folders).length > 0
  if (order.length === 0 && hidden.length === 0 && !named) return undefined
  return {
    sortFn: navSortFn(order),
    filterFn: navFilterFn(hidden),
    // Left off entirely when there is nothing to rename, so the attribute
    // Quartz writes into every page never carries an empty map.
    ...(named ? { mapFn: navMapFn(folders) } : {}),
  }
}

/**
 * Call each folder what the vault calls it.
 *
 * A folder has no file, so Quartz's trie has no title to read for one and falls
 * back to the slug segment: `wisdom-approaches`, where the vault says "Wisdom &
 * Approaches". The plugin knows the difference and sends it; this is where it
 * lands.
 *
 * Quartz runs `mapFn` before `sortFn` (its `order` option is filter, map, sort),
 * so a folder renamed here sorts under the name a reader sees rather than under
 * its address. Quartz's own default `mapFn` is a no-op, so replacing it costs
 * nothing.
 *
 * Same `new Function` construction as the two above, and for the same reason:
 * this is stringified into the page and rebuilt in the browser, so it can close
 * over nothing.
 */
export function navMapFn(folders: Record<string, string>): (node: NavSortNode) => void {
  const names = JSON.stringify(Object.entries(folders))
  return new Function(
    'node',
    // A Map for the reason `navSortFn` uses one: a folder slugged `__proto__`
    // must add a key rather than replace an object's prototype.
    `var names = new Map(${names})
var name = names.get(node.slug)
if (name !== undefined) node.displayName = name`,
  ) as (node: NavSortNode) => void
}

/**
 * Rank the siblings somebody arranged; leave every other pair to Quartz.
 *
 * A single flat list covers every parent at once, and that works because a
 * comparator is only ever handed two *siblings*: ranks belonging to different
 * folders are never compared with one another, so one running index across the
 * whole list orders each parent correctly on its own.
 *
 * Ranked beats unranked, and both beat the folders-first rule underneath. That
 * is the decision an explicit order exists to express: somebody who drags a note
 * above a folder meant it.
 */
export function navSortFn(order: readonly string[]): (a: NavSortNode, b: NavSortNode) => number {
  const ranks = JSON.stringify(order.map((slug, index) => [slug, index]))
  return new Function(
    'a',
    'b',
    // A Map, not an object literal: a page whose slug is `__proto__` would set
    // the prototype of an object literal instead of adding a key to it, and
    // then rank every sibling against a value nobody wrote.
    `var rank = new Map(${ranks})
var ra = rank.get(a.slug)
var rb = rank.get(b.slug)
if (ra !== undefined && rb !== undefined) return ra - rb
if (ra !== undefined) return -1
if (rb !== undefined) return 1
if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: "base" })`,
  ) as (a: NavSortNode, b: NavSortNode) => number
}

/**
 * Drop the hidden pages, and keep dropping `tags`.
 *
 * The second half is Quartz's own default filter. Replacing it rather than
 * adding to it would put the tag index into everybody's sidebar the moment they
 * hid a single page, which is a change nobody asked for arriving from a setting
 * about something else.
 *
 * Hiding a folder takes its subtree with it, because Quartz's `filter` walks
 * only the children that survived. That is the intended behaviour and matches
 * Obsidian Publish. Nothing about it unpublishes a page: every note underneath
 * is still built, still linked to, still searchable and still at its own URL.
 */
export function navFilterFn(hidden: readonly string[]): (node: NavSortNode) => boolean {
  const slugs = JSON.stringify([...hidden])
  return new Function(
    'node',
    `var hidden = new Set(${slugs})
return node.slugSegment !== "tags" && !hidden.has(node.slug)`,
  ) as (node: NavSortNode) => boolean
}
