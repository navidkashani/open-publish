/**
 * Navigation order and hidden pages: settings plus frontmatter, resolved into
 * the flat list the snapshot carries.
 *
 * Everything about precedence is decided here, so a starter receives one
 * ordered list of slugs and needs no rules of its own. That follows `homepage`,
 * which is resolved to a slug in the plugin for the same reason: a generator
 * should not have to reimplement a decision the plugin has already made, and
 * two generators reimplementing it would eventually disagree.
 *
 * The tree is built in **slug** space, because that is what the generator sorts
 * and what its comparator is handed. The keys settings use are **vault paths**,
 * because a slug moves when a note is renamed or given a `permalink` and a
 * stored order that quietly emptied itself would be worse than no order at all.
 * Mapping between the two is the fiddly half of this file and is why it is one
 * file rather than a few lines in the scanner.
 *
 * Pure data: no DOM and no Obsidian, so it is unit tested under plain Node.
 */

import { slugifySegment } from './slug.ts'
import type { SnapshotNav } from './snapshot.ts'

/**
 * The manager's answer, as stored in `data.json`.
 *
 * Vault paths, and both lists are flat. `order` is flat because a parent is
 * simply "a parent one of whose children is named in here": storing the
 * grouping as well would be a second copy of a fact the paths already carry,
 * and the two copies would drift the first time somebody moved a note.
 */
export interface NavSettings {
  order: string[]
  hidden: string[]
}

/** One published note, as much of it as arranging navigation needs. */
export interface NavNote {
  /** Vault path, which is what `NavSettings` names. */
  path: string
  /** Site slug, which is what the generator names. */
  slug: string
  /** The title the generator will show, and therefore the one it sorts by. */
  title: string
  /** `nav-order:` from the note's own frontmatter, when it is a finite number. */
  order?: number
  /** `nav-hidden:` from the note's own frontmatter, when it is a boolean. */
  hidden?: boolean
}

export interface NavNode {
  /**
   * The address the generator knows this node by: a note's own slug, or, for a
   * folder, the slug of its index page. See `SnapshotNav`.
   */
  key: string
  /**
   * Every vault path that names this node, most canonical first, so a settings
   * entry written against either a folder or its `index` note still matches.
   * Empty for a folder that no vault path lines up with, which can only happen
   * when a `permalink` has moved a note out of the shape its path implies.
   */
  paths: string[]
  /** What the generator will show. Matched to Quartz's `displayName`. */
  label: string
  isFolder: boolean
  children: NavNode[]
  /** Set only from the note's own frontmatter, so absence means "not stated". */
  order?: number
  /**
   * `nav-hidden:` as the note's frontmatter stated it, or absent. A folder can
   * only state this through its index note, which is the note the folder node
   * was built from; a folder with no index page has nowhere to say it.
   */
  statedHidden?: boolean
  /** Resolved: frontmatter if it said anything, otherwise the manager's list. */
  hidden: boolean
  /** True when frontmatter decided `hidden`, so the manager can say it lost. */
  hiddenByFrontmatter: boolean
}

/**
 * Past this many arranged entries the manager warns, because the cost is not
 * paid where it is incurred.
 *
 * A generator is free to inline the order into every page, and Quartz's
 * explorer does exactly that, so each entry is roughly thirty bytes on *every*
 * page of the site rather than thirty bytes once. Three hundred is around nine
 * kilobytes per page, which is the point at which it is worth knowing. It is a
 * warning and not a limit: somebody who wants it can have it.
 */
export const NAV_WARN_ENTRIES = 300

/**
 * The frontmatter reads, in one place because both of them have the same rule:
 * say nothing rather than guess. A `nav-order: soon` is not a zero and a
 * `nav-hidden: maybe` is not a yes.
 */
export function readNavOrder(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function readNavHidden(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Follow renames into the stored order.
 *
 * Best effort by construction: `detectRenames` recognises a rename by matching
 * content hashes, so a note renamed *and* edited in the same sitting is not
 * matched and its entry stays pointing at a path that no longer exists. That
 * degrades the way it should, into one item falling back to alphabetical, which
 * is why nothing here treats an unmatched entry as a problem.
 *
 * Returns null when nothing moved, so the caller can tell "no change" from "a
 * change that happens to look the same" and save `data.json` only when there is
 * something to save.
 */
export function migrateNavPaths(
  settings: NavSettings,
  renames: Array<{ from: string; to: string }>,
  /**
   * Is anything still published under this folder?
   *
   * The one fact that separates a renamed folder from a note moved out of one,
   * and the reason this takes a third argument at all. Both look identical in
   * `renames`: a note that was in `Notes/` and now is not. Guessing wrong is
   * the expensive direction, because it would rewrite the entry for a folder
   * nobody touched and rearrange a part of the sidebar nobody asked about.
   */
  stillPublished: (folder: string) => boolean,
): NavSettings | null {
  if (renames.length === 0) return null
  const moves = new Map(renames.map((rename) => [rename.from, rename.to]))

  /**
   * Where a folder went, or null when that cannot be told.
   *
   * A renamed folder arrives as a rename per note inside it and never as itself,
   * so it has to be inferred: every note that left it has to agree on where it
   * landed, each has to have kept its own name, and nothing published may be
   * left behind in the old folder. Fail any of those and the entry is left
   * alone, which costs that folder its place and costs nothing else.
   */
  const folderMove = (folder: string): string | null => {
    if (stillPublished(folder)) return null
    const prefix = `${folder}/`
    let destination: string | null = null
    for (const [from, to] of moves) {
      if (!from.startsWith(prefix)) continue
      const tail = from.slice(prefix.length)
      if (!to.endsWith(`/${tail}`)) return null
      const candidate = to.slice(0, to.length - tail.length - 1)
      if (destination !== null && destination !== candidate) return null
      destination = candidate
    }
    return destination
  }

  const follow = (path: string): string => moves.get(path) ?? folderMove(path) ?? path
  const migrated: NavSettings = { order: settings.order.map(follow), hidden: settings.hidden.map(follow) }
  const same =
    migrated.order.every((path, i) => path === settings.order[i]) &&
    migrated.hidden.every((path, i) => path === settings.hidden[i])
  return same ? null : migrated
}

/**
 * The published notes as the tree the generator will build, in the order it
 * will show them.
 *
 * Shared by the manager, which renders it, and by `resolveNav`, which measures
 * it against the default. One builder, so the rows somebody drags are the rows
 * the site ends up with.
 */
export function buildNavTree(notes: NavNote[], settings: NavSettings): NavNode[] {
  const root = buildNodes(notes)
  const rank = new Map(settings.order.map((path, index) => [path, index]))
  const hidden = new Set(settings.hidden)
  applyHidden(root, hidden)
  return sortTree(root, rank)
}

/**
 * The navigation the snapshot should carry, or null when it would say nothing.
 *
 * Null rather than two empty lists is what keeps this free: a vault that has
 * never opened the manager produces the snapshot it always did, down to the ID,
 * and therefore does not spend a build on a feature it does not use. Same for a
 * single parent, which is carried only when somebody arranged it.
 */
export function resolveNav(notes: NavNote[], settings: NavSettings): SnapshotNav | null {
  const root = buildNodes(notes)
  const rank = new Map(settings.order.map((path, index) => [path, index]))
  applyHidden(root, new Set(settings.hidden))

  const hiddenKeys: string[] = []
  const order: string[] = []

  const walk = (children: NavNode[]): void => {
    // Hiding a folder takes its whole subtree with it, so nothing inside one is
    // worth an entry: the generator will never sort those siblings at all.
    const visible = children.filter((child) => {
      if (child.hidden) hiddenKeys.push(child.key)
      return !child.hidden
    })

    // Carried because somebody arranged this parent, not because the result
    // happens to differ from one generator's idea of the default. See
    // `isAddressed`, which is where that distinction is argued.
    if (isAddressed(visible, rank)) {
      for (const node of arrange(visible, rank)) order.push(node.key)
    }
    for (const child of visible) walk(child.children)
  }
  walk(root)

  if (order.length === 0 && hiddenKeys.length === 0) return null
  return { order, hidden: hiddenKeys }
}

/**
 * One parent's siblings, in the order they should appear.
 *
 * The three steps in the order they have to run in. Frontmatter is last because
 * frontmatter wins, which is the project's rule everywhere else a note can
 * argue with a setting.
 */
function arrange(siblings: NavNode[], rank: Map<string, number>): NavNode[] {
  // 1. The generator's own default: folders first, then files, each natural.
  let resolved = [...siblings].sort(compareDefault)

  // 2. The manager's arrangement, for the siblings it names. Anything it does
  //    not name keeps its default place, after the ones it does, so arranging
  //    one note in a folder of twenty costs one entry rather than twenty.
  const indexOf = (node: NavNode): number | undefined => rankOf(node, rank)
  const arranged = resolved.filter((node) => indexOf(node) !== undefined)
  if (arranged.length > 0) {
    arranged.sort((a, b) => (indexOf(a) as number) - (indexOf(b) as number))
    resolved = [...arranged, ...resolved.filter((node) => indexOf(node) === undefined)]
  }

  // 3. Frontmatter, which outranks both. A note that states a number goes ahead
  //    of every sibling that states none, which is what makes a fractional
  //    value useful: 1.5 slots between 1 and 2 with nothing renumbered.
  const pinned = resolved.filter((node) => node.order !== undefined)
  if (pinned.length > 0) {
    // Stable, so equal numbers fall back to the order step 2 left them in
    // rather than to whatever the engine feels like.
    pinned.sort((a, b) => (a.order as number) - (b.order as number))
    resolved = [...pinned, ...resolved.filter((node) => node.order === undefined)]
  }

  return resolved
}

/** Where the manager put this node, taking the first of its names that it knows. */
function rankOf(node: NavNode, rank: Map<string, number>): number | undefined {
  let best: number | undefined
  for (const path of node.paths) {
    const found = rank.get(path)
    if (found !== undefined && (best === undefined || found < best)) best = found
  }
  return best
}

/**
 * Has anybody said anything about the order of these siblings?
 *
 * This, rather than "does the result differ from the default", is what decides
 * whether a parent is worth carrying, and the difference is not academic. The
 * default is the *generator's*, and generators disagree: Quartz puts folders
 * first everywhere, and jotter deliberately puts the root's loose notes above
 * its folders, because those are a site's front doors. Measuring against one of
 * them and staying silent on a match means an arrangement that happens to equal
 * Quartz's default reaches jotter as no instruction at all, and jotter then
 * renders the opposite of what the manager showed. Somebody dragged a folder to
 * the top and the site quietly put it back.
 *
 * What the byte budget actually needs is that a parent nobody has touched costs
 * nothing, and that is true here too: an untouched parent is named nowhere and
 * has no frontmatter to read. What is given up is the narrower saving when
 * somebody drags a row and puts it back, which is a handful of slugs and the
 * right price for the sidebar agreeing with itself.
 *
 * Hiding is deliberately not included. It travels in its own list and leaves
 * the order of whatever is left exactly as the generator would have had it, so
 * it is not an instruction about order and must not force one to be written.
 */
function isAddressed(siblings: NavNode[], rank: Map<string, number>): boolean {
  return siblings.some((node) => node.order !== undefined || rankOf(node, rank) !== undefined)
}

/**
 * Quartz's own comparator, expressed over our nodes: folders first, then files,
 * each compared the way a person reads numbers.
 *
 * The tiebreak is ours and Quartz has none. Two siblings whose display names
 * differ only in case or accent are in an order Quartz does not define, so
 * picking one keeps this function deterministic without changing any answer
 * Quartz actually commits to.
 */
function compareDefault(a: NavNode, b: NavNode): number {
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1
  const byLabel = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
  if (byLabel !== 0) return byLabel
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

interface Draft {
  segments: string[]
  children: Map<string, Draft>
  note?: NavNote
  /** True once something has made this a folder: an index note, or a child. */
  isFolder: boolean
  /** Vault directory this folder lines up with, when a note's path implies one. */
  folderPath?: string
}

/**
 * The slug tree, with each node's vault identity attached.
 *
 * Built from slugs rather than vault paths because slugs are what the generator
 * groups by: a `permalink` can move a note into a different folder on the site
 * than the one it sits in on disk, and the sidebar shows where it landed.
 */
function buildNodes(notes: NavNote[]): NavNode[] {
  const root: Draft = { segments: [], children: new Map(), isFolder: true }

  const ensure = (segments: string[]): Draft => {
    let node = root
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      let child = node.children.get(segment)
      if (!child) {
        child = { segments: segments.slice(0, i + 1), children: new Map(), isFolder: false }
        node.children.set(segment, child)
      }
      node.isFolder = true
      node = child
    }
    return node
  }

  // Sorted, so the vault path a folder ends up claiming is the same one on
  // every run rather than whichever note happened to be scanned first.
  const sorted = [...notes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  for (const note of sorted) {
    const segments = note.slug.split('/').filter((segment) => segment.length > 0)
    if (segments.length === 0) continue

    // A bare `index` is the homepage, and it is a row like any other rather
    // than the site root wearing a slug. Generators disagree about it and both
    // are served by saying so: Quartz's trie keeps the homepage as the root
    // node's own data and never as a child, so an entry naming it is compared
    // with nothing and sits in the list inert; jotter draws `/` in its sidebar,
    // sorted among the root's notes, and the entry lands. Refusing to make the
    // row would leave jotter with a row the manager can neither show nor order.
    //
    // The guard is on the depth, so `Notes/index.md` still takes the branch
    // below and names its folder: a homepage is only ever at the root.
    const isIndex = segments.length > 1 && segments[segments.length - 1] === 'index'
    const node = ensure(isIndex ? segments.slice(0, -1) : segments)
    node.note ??= note
    if (isIndex) node.isFolder = true

    // Which vault directory each ancestor folder corresponds to.
    //
    // Checked segment by segment against the real slugifier rather than assumed
    // from the depths matching. A `permalink` can put `Drafts/Essay.md` into the
    // site's `writing` folder, and that note must not then hand the name of its
    // own vault folder to a folder it is only visiting: hiding "Writing" would
    // hide "Drafts", which is a different set of notes.
    const parts = note.path.split('/').filter((part) => part.length > 0)
    if (parts.length !== segments.length) continue
    for (let depth = 1; depth < segments.length; depth++) {
      if (slugifySegment(parts[depth - 1]) !== segments[depth - 1]) break
      const folder = ensure(segments.slice(0, depth))
      folder.folderPath ??= parts.slice(0, depth).join('/')
    }
  }

  const convert = (draft: Draft): NavNode => {
    const segment = draft.segments[draft.segments.length - 1] ?? ''
    const slugPath = draft.segments.join('/')
    const isFolder = draft.isFolder || draft.children.size > 0
    const title = draft.note?.title
    const paths: string[] = []
    // The folder itself first: it is what somebody reading `data.json` expects
    // to see, and it is the only name a folder with no index note has.
    if (isFolder && draft.folderPath) paths.push(draft.folderPath)
    if (draft.note) paths.push(draft.note.path)

    return {
      key: isFolder ? `${slugPath}/index` : slugPath,
      paths,
      // Quartz shows a note's title, except the literal "index", which is the
      // filename of a folder page rather than a name anybody chose.
      label: title && title !== 'index' ? title : segment,
      isFolder,
      children: [...draft.children.values()].map(convert),
      ...(draft.note?.order !== undefined ? { order: draft.note.order } : {}),
      ...(draft.note?.hidden !== undefined ? { statedHidden: draft.note.hidden } : {}),
      hidden: false,
      hiddenByFrontmatter: false,
    }
  }

  return [...root.children.values()].map(convert)
}

/** Frontmatter decides when it says anything at all; the manager decides otherwise. */
function applyHidden(nodes: NavNode[], hidden: Set<string>): void {
  for (const node of nodes) {
    node.hidden = node.statedHidden ?? node.paths.some((path) => hidden.has(path))
    node.hiddenByFrontmatter = node.statedHidden !== undefined
    applyHidden(node.children, hidden)
  }
}

function sortTree(nodes: NavNode[], rank: Map<string, number>): NavNode[] {
  const sorted = arrange(nodes, rank)
  for (const node of sorted) node.children = sortTree(node.children, rank)
  return sorted
}
