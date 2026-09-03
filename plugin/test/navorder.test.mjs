/**
 * Navigation order: what the snapshot ends up carrying, and, just as often,
 * what it deliberately does not.
 *
 * The assertion that matters most in here is the quiet one: a parent nobody
 * arranged is not in the snapshot at all. That is what keeps this feature free
 * for the vault that never opens it, and it is the difference between shipping
 * twenty slugs and shipping five thousand on every page of somebody's site.
 *
 * Its near neighbour is the one that used to be wrong. A parent somebody *did*
 * arrange is carried even when the result matches the default, because "the
 * default" belongs to a generator and generators disagree about it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NAV_WARN_ENTRIES,
  buildNavTree,
  migrateNavPaths,
  readNavHidden,
  readNavOrder,
  resolveNav,
} from '../src/core/navorder.ts'

const EMPTY = { order: [], hidden: [] }

/** A published note: vault path, slug and title, which is what the sort sees. */
const note = (path, slug, title, extra = {}) => ({ path, slug, title, ...extra })

/**
 * A small vault with a folder, a note beside it and a note inside it. Titles
 * differ from slugs on purpose: the generator sorts by title, so anything that
 * sorted by slug would pass on a vault where they happen to agree.
 */
const VAULT = [
  note('Apple.md', 'apple', 'Apple'),
  note('Zebra.md', 'zebra', 'Zebra'),
  note('Notes/Beta.md', 'notes/beta', 'Beta'),
  note('Notes/Alpha.md', 'notes/alpha', 'Alpha'),
]

const labels = (nodes) => nodes.map((node) => node.label)

test('nothing arranged means nothing carried, so an untouched vault costs no bytes', () => {
  assert.equal(resolveNav(VAULT, EMPTY), null)
})

test('the default is the generator\'s own: folders first, then notes, each natural', () => {
  const tree = buildNavTree(VAULT, EMPTY)
  // A folder with no index page is labelled by its slug segment, lowercase,
  // because that is exactly what the generator will print in the sidebar. This
  // dialog shows the site, not the vault.
  assert.deepEqual(labels(tree), ['notes', 'Apple', 'Zebra'])
  assert.deepEqual(labels(tree[0].children), ['Alpha', 'Beta'])
})

test('a folder is named by the slug of its index page, which is what a trie calls it', () => {
  const tree = buildNavTree(VAULT, EMPTY)
  assert.equal(tree[0].key, 'notes/index')
  assert.equal(tree[0].isFolder, true)
  assert.equal(tree[1].key, 'apple')
})

test('an arranged parent is materialised in full; every other parent costs nothing', () => {
  const nav = resolveNav(VAULT, { order: ['Zebra.md', 'Apple.md'], hidden: [] })
  // The root was arranged, so the root's three children are listed. The Notes
  // folder was not touched, so neither of its notes appears at all.
  assert.deepEqual(nav.order, ['zebra', 'apple', 'notes/index'])
  assert.deepEqual(nav.hidden, [])
})

test('a parent nobody arranged is not in the snapshot at all', () => {
  // The byte budget, and the whole of why the order is per parent. Arranging
  // one folder must not cost every page of the site an entry for every other.
  const nav = resolveNav(VAULT, { order: ['Notes/Beta.md', 'Notes/Alpha.md'], hidden: [] })
  assert.deepEqual(nav.order, ['notes/beta', 'notes/alpha'], 'the arranged folder, and nothing else')
})

test('an arrangement is carried even when it matches the default', () => {
  // This is the one that used to be wrong, and it was not academic. The default
  // is the *generator's*, and generators disagree: Quartz puts folders first
  // everywhere, jotter deliberately puts the root's loose notes above them. An
  // arrangement measured against one of them and dropped on a match reaches the
  // other as no instruction, and the site quietly renders the opposite of what
  // the manager showed.
  const nav = resolveNav(VAULT, { order: ['Notes', 'Apple.md', 'Zebra.md'], hidden: [] })
  assert.deepEqual(nav.order, ['notes/index', 'apple', 'zebra'])
})

test('naming only some siblings promotes them, which is a real change and is emitted', () => {
  // Not a special case of the test above: naming two of three says "these two
  // first", and putting the folder last is what that means.
  const nav = resolveNav(VAULT, { order: ['Apple.md', 'Zebra.md'], hidden: [] })
  assert.deepEqual(nav.order, ['apple', 'zebra', 'notes/index'])
})

test('siblings the arrangement does not name keep their default place, after the ones it does', () => {
  const notes = [
    note('A.md', 'a', 'A'),
    note('B.md', 'b', 'B'),
    note('C.md', 'c', 'C'),
    note('D.md', 'd', 'D'),
  ]
  const nav = resolveNav(notes, { order: ['D.md'], hidden: [] })
  assert.deepEqual(nav.order, ['d', 'a', 'b', 'c'])
})

test('an order is scoped to its own parent, so two folders do not interfere', () => {
  const notes = [
    note('One/A.md', 'one/a', 'A'),
    note('One/B.md', 'one/b', 'B'),
    note('Two/A.md', 'two/a', 'A'),
    note('Two/B.md', 'two/b', 'B'),
  ]
  const nav = resolveNav(notes, { order: ['One/B.md', 'One/A.md'], hidden: [] })
  assert.deepEqual(nav.order, ['one/b', 'one/a'], 'Two was never touched, so Two is not in here')
})

test('an explicit order outranks folders-first: a note can be put above a folder', () => {
  const nav = resolveNav(VAULT, { order: ['Apple.md', 'Notes', 'Zebra.md'], hidden: [] })
  assert.deepEqual(nav.order, ['apple', 'notes/index', 'zebra'])
})

test('a folder can be named by its own path or by its index note, and both match', () => {
  const notes = [note('Notes/index.md', 'notes/index', 'Notes'), note('Apple.md', 'apple', 'Apple')]
  const byFolder = resolveNav(notes, { order: ['Apple.md', 'Notes'], hidden: [] })
  const byIndex = resolveNav(notes, { order: ['Apple.md', 'Notes/index.md'], hidden: [] })
  assert.deepEqual(byFolder.order, ['apple', 'notes/index'])
  assert.deepEqual(byIndex.order, byFolder.order)
})

test('an index note gives its folder the title it wrote, not the word "index"', () => {
  const notes = [note('Notes/index.md', 'notes/index', 'Field Guide'), note('Apple.md', 'apple', 'Apple')]
  const tree = buildNavTree(notes, EMPTY)
  assert.deepEqual(labels(tree), ['Field Guide', 'Apple'])

  const literal = [note('Notes/index.md', 'notes/index', 'index'), note('Apple.md', 'apple', 'Apple')]
  assert.deepEqual(labels(buildNavTree(literal, EMPTY)), ['notes', 'Apple'], 'the folder segment, as Quartz does')
  assert.deepEqual(buildNavTree(literal, EMPTY)[0].paths, ['Notes', 'Notes/index.md'])
})

// --- frontmatter -----------------------------------------------------------

test('frontmatter beats the manager, which is the rule everywhere else too', () => {
  const notes = [
    note('A.md', 'a', 'A', { order: 2 }),
    note('B.md', 'b', 'B'),
    note('C.md', 'c', 'C', { order: 1 }),
  ]
  const nav = resolveNav(notes, { order: ['B.md', 'A.md', 'C.md'], hidden: [] })
  assert.deepEqual(nav.order, ['c', 'a', 'b'], 'the two numbered notes lead, in their numbers')
})

test('a stated number leads every sibling that states none', () => {
  const notes = [note('A.md', 'a', 'A'), note('B.md', 'b', 'B'), note('Z.md', 'z', 'Z', { order: 100 })]
  assert.deepEqual(resolveNav(notes, EMPTY).order, ['z', 'a', 'b'])
})

test('negatives pin to the top and fractions slot between, with nothing renumbered', () => {
  const notes = [
    note('A.md', 'a', 'A', { order: 1 }),
    note('B.md', 'b', 'B', { order: 2 }),
    note('Wedge.md', 'wedge', 'Wedge', { order: 1.5 }),
    note('First.md', 'first', 'First', { order: -3 }),
  ]
  assert.deepEqual(resolveNav(notes, EMPTY).order, ['first', 'a', 'wedge', 'b'])
})

test('equal numbers break by the order underneath, not by chance', () => {
  const notes = [
    note('A.md', 'a', 'Alpha', { order: 1 }),
    note('B.md', 'b', 'Beta', { order: 1 }),
    note('C.md', 'c', 'Gamma', { order: 1 }),
  ]
  // Nothing else has spoken, so the tie falls back to the natural comparator.
  // Carried rather than dropped, because a note stating a number is an
  // instruction about the order of its siblings whatever it works out to.
  assert.deepEqual(resolveNav(notes, EMPTY).order, ['a', 'b', 'c'])
  // With the manager having spoken, the tie falls back to what it said.
  assert.deepEqual(resolveNav(notes, { order: ['C.md', 'B.md', 'A.md'], hidden: [] }).order, ['c', 'b', 'a'])
})

test('a value that is not a number is ignored rather than coerced', () => {
  for (const value of ['3', null, true, [1], { n: 1 }, Number.NaN, Infinity, undefined]) {
    assert.equal(readNavOrder(value), undefined, `${JSON.stringify(value)} is not an order`)
  }
  assert.equal(readNavOrder(0), 0, 'zero is a number and a perfectly good position')
  assert.equal(readNavOrder(-2.5), -2.5)
})

test('a value that is not a boolean does not hide anything', () => {
  for (const value of ['true', 1, null, undefined, []]) {
    assert.equal(readNavHidden(value), undefined, `${JSON.stringify(value)} is not an answer`)
  }
  assert.equal(readNavHidden(false), false)
  assert.equal(readNavHidden(true), true)
})

// --- hiding ----------------------------------------------------------------

test('a hidden page leaves the navigation and stays in the snapshot', () => {
  const nav = resolveNav(VAULT, { order: [], hidden: ['Zebra.md'] })
  assert.deepEqual(nav.hidden, ['zebra'])
  // Hiding is not an instruction about order: whatever is left keeps the order
  // the generator would have given it, so there is nothing to write down.
  assert.deepEqual(nav.order, [])
})

test('frontmatter can hide, and can also refuse to be hidden', () => {
  const notes = [note('A.md', 'a', 'A', { hidden: true }), note('B.md', 'b', 'B', { hidden: false })]
  const nav = resolveNav(notes, { order: [], hidden: ['B.md'] })
  assert.deepEqual(nav.hidden, ['a'], 'nav-hidden: false in the note wins over the manager')
})

test('a hidden folder takes its subtree with it, and nothing inside is listed twice', () => {
  const notes = [
    note('Notes/Alpha.md', 'notes/alpha', 'Alpha'),
    note('Notes/Beta.md', 'notes/beta', 'Beta'),
    note('Apple.md', 'apple', 'Apple'),
  ]
  const nav = resolveNav(notes, { order: [], hidden: ['Notes'] })
  assert.deepEqual(nav.hidden, ['notes/index'])
  assert.deepEqual(nav.order, [], 'the folder is gone, so its children are not worth ordering')
})

test('the order a hidden sibling leaves behind is the order that ships', () => {
  // The generator filters before it sorts, so the default this is measured
  // against is the default over what survived the filter.
  const notes = [note('A.md', 'a', 'A'), note('B.md', 'b', 'B'), note('C.md', 'c', 'C')]
  const nav = resolveNav(notes, { order: ['C.md', 'A.md'], hidden: ['A.md'] })
  assert.deepEqual(nav.hidden, ['a'])
  assert.deepEqual(nav.order, ['c', 'b'], 'A is filtered out, so it is not in the order either')
})

// --- what falls out of the snapshot ----------------------------------------

test('a note that stopped being published drops out of the snapshot and stays in settings', () => {
  const settings = { order: ['Zebra.md', 'Apple.md', 'Gone.md'], hidden: ['Gone.md'] }
  const nav = resolveNav(VAULT, settings)
  assert.equal(nav.order.includes('gone'), false)
  assert.deepEqual(nav.hidden, [], 'nothing published is hidden, so nothing is named')
  assert.deepEqual(
    settings.order,
    ['Zebra.md', 'Apple.md', 'Gone.md'],
    'resolving is a read: unpublishing a note for an afternoon must not destroy its place',
  )
})

test('a note the arrangement never mentions is simply left alone', () => {
  const nav = resolveNav(VAULT, { order: ['Nowhere/Else.md'], hidden: [] })
  assert.equal(nav, null)
})

// --- the homepage --------------------------------------------------------

test('the homepage is a root row like any other, keyed by the slug it is served at', () => {
  const notes = [note('Home.md', 'index', 'Home'), note('Apple.md', 'apple', 'Apple')]
  const tree = buildNavTree(notes, EMPTY)
  assert.deepEqual(labels(tree), ['Apple', 'Home'])
  assert.equal(tree[1].key, 'index')
  assert.deepEqual(tree[1].paths, ['Home.md'], 'a path to store a decision against, like any other note')
})

test('the homepage can be arranged among the root notes, and its own nav-order counts', () => {
  // Quartz keeps the homepage as the root node's own data rather than as a
  // child, so an entry naming it is compared with nothing and sits in the list
  // inert. jotter draws it in the sidebar, and there the entry lands. Saying it
  // is right for both: the plugin states what the site shows, and a generator
  // with no such row ignores the line.
  const notes = [note('Home.md', 'index', 'Home'), note('Apple.md', 'apple', 'Apple'), note('Z.md', 'z', 'Z')]
  const byManager = resolveNav(notes, { order: ['Home.md', 'Z.md', 'Apple.md'], hidden: [] })
  assert.deepEqual(byManager.order, ['index', 'z', 'apple'])

  const stated = [note('Home.md', 'index', 'Home', { order: 1 }), note('Apple.md', 'apple', 'Apple')]
  assert.deepEqual(resolveNav(stated, EMPTY).order, ['index', 'apple'])
})

test('the homepage can be hidden, which is odd and coherent', () => {
  // The site still opens on that page: the homepage is where a site starts,
  // not a link in a list.
  const notes = [note('Home.md', 'index', 'Home'), note('Apple.md', 'apple', 'Apple')]
  const nav = resolveNav(notes, { order: [], hidden: ['Home.md'] })
  assert.deepEqual(nav.hidden, ['index'])
})

test('a homepage that lives inside a folder draws at the root, and claims no folder', () => {
  // Where it is served, not where the file sits: the panel shows the site. And
  // it must not hand its vault folder's name to the folder node, or hiding
  // "notes" would store a decision against the homepage's own path.
  const notes = [note('Notes/Home.md', 'index', 'Home'), note('Notes/Alpha.md', 'notes/alpha', 'Alpha')]
  const tree = buildNavTree(notes, EMPTY)
  assert.deepEqual(labels(tree), ['notes', 'Home'])
  assert.deepEqual(tree[0].paths, ['Notes'])
  assert.deepEqual(tree[1].paths, ['Notes/Home.md'])
  assert.deepEqual(labels(tree[0].children), ['Alpha'], 'and it is not also inside the folder')
})

test('a folder index page is still a folder, because the guard is on the depth', () => {
  const notes = [note('Notes/index.md', 'notes/index', 'Notes'), note('Apple.md', 'apple', 'Apple')]
  const tree = buildNavTree(notes, EMPTY)
  assert.equal(tree[0].key, 'notes/index')
  assert.equal(tree[0].isFolder, true)
})

// --- renames ---------------------------------------------------------------

/** Nothing is left in the old folder, which is what a folder rename looks like. */
const emptied = () => false

test('a renamed note keeps its place', () => {
  const migrated = migrateNavPaths(
    { order: ['Notes/Old.md', 'Apple.md'], hidden: ['Notes/Old.md'] },
    [{ from: 'Notes/Old.md', to: 'Notes/New.md' }],
    () => true,
  )
  assert.deepEqual(migrated.order, ['Notes/New.md', 'Apple.md'])
  assert.deepEqual(migrated.hidden, ['Notes/New.md'])
})

test('a renamed folder is followed through the notes that moved with it', () => {
  const migrated = migrateNavPaths(
    { order: ['Notes', 'Apple.md'], hidden: [] },
    [
      { from: 'Notes/Alpha.md', to: 'Journal/Alpha.md' },
      { from: 'Notes/Beta.md', to: 'Journal/Beta.md' },
    ],
    emptied,
  )
  assert.deepEqual(migrated.order, ['Journal', 'Apple.md'])
})

test('a note moved out of a folder that still has notes does not take the folder with it', () => {
  // The two look identical in a rename list, and guessing wrong here would
  // rewrite the entry for a folder nobody touched. So the folder staying
  // populated is what settles it.
  const migrated = migrateNavPaths(
    { order: ['Notes', 'Apple.md'], hidden: [] },
    [{ from: 'Notes/Alpha.md', to: 'Archive/Alpha.md' }],
    (folder) => folder === 'Notes',
  )
  assert.equal(migrated, null, 'the folder entry is left exactly as it was')
})

test('notes that scattered in different directions take no folder anywhere', () => {
  const migrated = migrateNavPaths(
    { order: ['Notes'], hidden: [] },
    [
      { from: 'Notes/Alpha.md', to: 'Archive/Alpha.md' },
      { from: 'Notes/Beta.md', to: 'Journal/Beta.md' },
    ],
    emptied,
  )
  assert.equal(migrated, null)
})

test('a note renamed as it moved says nothing about where its folder went', () => {
  const migrated = migrateNavPaths(
    { order: ['Notes'], hidden: [] },
    [{ from: 'Notes/Alpha.md', to: 'Journal/Something Else.md' }],
    emptied,
  )
  assert.equal(migrated, null)
})

test('nothing moved means nothing to save', () => {
  assert.equal(migrateNavPaths({ order: ['A.md'], hidden: [] }, [], emptied), null)
  assert.equal(
    migrateNavPaths({ order: ['A.md'], hidden: [] }, [{ from: 'B.md', to: 'C.md' }], () => true),
    null,
    'a rename of something this order never mentioned changes nothing',
  )
})

test('a rename that cannot be matched degrades into alphabetical, not into an error', () => {
  // `detectRenames` matches on content hash, so a note renamed *and* edited is
  // not recognised. Its entry stays pointing at a path nothing has any more.
  const settings = { order: ['Notes/Old.md', 'Apple.md'], hidden: [] }
  assert.equal(migrateNavPaths(settings, [], () => true), null)
  const nav = resolveNav(VAULT, settings)
  assert.equal(nav.order.includes('notes/old'), false)
})

// --- the shape of the thing ------------------------------------------------

test('the warning threshold is a number the manager and the settings row agree on', () => {
  assert.equal(typeof NAV_WARN_ENTRIES, 'number')
  assert.ok(NAV_WARN_ENTRIES > 0)
})

test('a permalink that moves a note to another folder moves it in the sidebar too', () => {
  // The sidebar shows where a page landed, not where its file sits on disk.
  const notes = [
    note('Drafts/Essay.md', 'writing/essay', 'Essay'),
    note('Writing/Other.md', 'writing/other', 'Other'),
  ]
  const tree = buildNavTree(notes, EMPTY)
  assert.deepEqual(labels(tree), ['writing'])
  assert.deepEqual(labels(tree[0].children), ['Essay', 'Other'])
  // And the folder takes the vault path that really is that folder. Taking
  // "Drafts" from the visiting note would mean hiding "writing" hid "Drafts",
  // which is an entirely different set of notes.
  assert.deepEqual(tree[0].paths, ['Writing'])
})
