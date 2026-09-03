/**
 * The sort, the filter and the rename Quartz's explorer is handed, put through
 * the exact transform the browser performs on them.
 *
 * `Explorer.tsx` stringifies them into a `data-data-fns` attribute and
 * `explorer.inline.ts` rebuilds them with `new Function("return " + src)()`. A
 * closure survives every test that calls the function directly and dies on that
 * round trip, silently: the sidebar renders in some other order and no error
 * reaches anybody. So every assertion in here is made against the rebuilt copy,
 * not the original.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { navExplorerOptions, navFilterFn, navMapFn, navSortFn } from '../nav-sort.ts'

/** Exactly what `explorer.inline.ts` does with the attribute it reads back. */
const rebuild = (fn) => new Function('return ' + fn.toString())()

/** As much of Quartz's `FileTrieNode` as any of the three functions touches. */
const node = (slug, { isFolder = false, displayName } = {}) => ({
  slug,
  slugSegment: slug.split('/').pop(),
  displayName: displayName ?? slug.split('/').pop(),
  isFolder,
})

const sorted = (fn, nodes) => [...nodes].sort(fn).map((n) => n.slug)

test('the comparator survives being stringified and rebuilt', () => {
  const sort = rebuild(navSortFn(['c', 'a', 'b']))
  assert.deepEqual(sorted(sort, [node('a'), node('b'), node('c')]), ['c', 'a', 'b'])
})

test('the filter survives it too, and keeps dropping tags', () => {
  const filter = rebuild(navFilterFn(['secret']))
  assert.equal(filter(node('tags', { isFolder: true })), false, "Quartz's own default filter is still in there")
  assert.equal(filter(node('secret')), false)
  assert.equal(filter(node('kept')), true)
})

test('a rebuilt comparator mentions no name the browser has never bound', () => {
  // The failure this is really about: a closure stringifies to source that
  // reads a variable which only ever existed at build time.
  const source = navSortFn(['a']).toString()
  assert.match(source, /new Map\(\[\["a",0\]\]\)/, 'the ranks travel inside the source, not around it')
  assert.doesNotThrow(() => rebuild(navSortFn(['a'])), 'and rebuilding it needs nothing from out here')
})

test('unranked siblings fall back to folders first, then natural order', () => {
  const sort = rebuild(navSortFn([]))
  const nodes = [node('b10'), node('b9'), node('zzz', { isFolder: true }), node('a')]
  assert.deepEqual(sorted(sort, nodes), ['zzz', 'a', 'b9', 'b10'], '"9" before "10", as a person reads them')
})

test('a ranked sibling beats an unranked one, whatever either of them is', () => {
  // The decision an explicit order exists to express: somebody who put a note
  // above a folder meant it, and folders-first does not get to undo that.
  const sort = rebuild(navSortFn(['note']))
  assert.deepEqual(sorted(sort, [node('folder', { isFolder: true }), node('note')]), ['note', 'folder'])
})

test('ranks from different parents never meet, so one flat list orders them all', () => {
  // A comparator only ever sees two siblings, so a single running index across
  // every arranged parent is enough. This is what keeps the attribute small.
  const sort = rebuild(navSortFn(['one/b', 'one/a', 'two/b', 'two/a']))
  assert.deepEqual(sorted(sort, [node('one/a'), node('one/b')]), ['one/b', 'one/a'])
  assert.deepEqual(sorted(sort, [node('two/a'), node('two/b')]), ['two/b', 'two/a'])
})

test('a page called __proto__ ranks like any other page', () => {
  // An object literal would take `{"__proto__": 0}` as an instruction to set
  // the prototype and rank every sibling against a value nobody wrote. A Map
  // has no such opinion, which is why the source builds one.
  const sort = rebuild(navSortFn(['__proto__', 'a']))
  assert.deepEqual(sorted(sort, [node('a'), node('__proto__')]), ['__proto__', 'a'])
})

test('folders are ranked by the slug of their index page', () => {
  const sort = rebuild(navSortFn(['notes/index', 'apple']))
  const nodes = [node('apple'), node('notes/index', { isFolder: true, displayName: 'notes' })]
  assert.deepEqual(sorted(sort, nodes), ['notes/index', 'apple'])
})

test('an empty arrangement produces no options at all, so the explorer is untouched', () => {
  // Not options that happen to be no-ops: `Explorer(undefined)` is the same
  // call as `Explorer()`, down to the rendered byte.
  assert.equal(navExplorerOptions(undefined), undefined)
  assert.equal(navExplorerOptions({ order: [], hidden: [] }), undefined)
  assert.equal(navExplorerOptions({ order: [], hidden: [] }, {}), undefined)
  assert.notEqual(navExplorerOptions({ order: ['a'], hidden: [] }), undefined)
  assert.notEqual(navExplorerOptions({ order: [], hidden: ['a'] }), undefined)
  assert.notEqual(
    navExplorerOptions(undefined, { 'notes/index': 'Notes' }),
    undefined,
    'names alone are worth options: nothing else can tell Quartz what a folder is called',
  )
})

test('the options carry every function they need, and all of them round trip', () => {
  const options = navExplorerOptions({ order: ['b', 'a'], hidden: ['c'] }, { 'notes/index': 'Notes' })
  assert.deepEqual(sorted(rebuild(options.sortFn), [node('a'), node('b')]), ['b', 'a'])
  assert.equal(rebuild(options.filterFn)(node('c')), false)
  assert.equal(rebuild(options.filterFn)(node('tags')), false)
  const folder = node('notes/index', { isFolder: true, displayName: 'notes' })
  rebuild(options.mapFn)(folder)
  assert.equal(folder.displayName, 'Notes')
})

test('no names means no mapFn at all, rather than one that renames nothing', () => {
  const options = navExplorerOptions({ order: ['a'], hidden: [] })
  assert.equal('mapFn' in options, false, 'the attribute Quartz writes on every page carries no empty map')
})

// --- what a folder is called -----------------------------------------------

test('the rename survives being stringified and rebuilt, like the other two', () => {
  const map = rebuild(navMapFn({ 'wisdom-approaches/index': 'Wisdom & Approaches' }))
  const folder = node('wisdom-approaches/index', { isFolder: true, displayName: 'wisdom-approaches' })
  map(folder)
  assert.equal(folder.displayName, 'Wisdom & Approaches')
})

test('a folder the names do not mention keeps whatever Quartz called it', () => {
  const map = rebuild(navMapFn({ 'notes/index': 'Notes' }))
  const other = node('other/index', { isFolder: true, displayName: 'other' })
  map(other)
  assert.equal(other.displayName, 'other')
})

test('a note is untouched, because the names only ever key folders', () => {
  const map = rebuild(navMapFn({ 'notes/index': 'Notes' }))
  const note = node('notes/alpha', { displayName: 'Alpha' })
  map(note)
  assert.equal(note.displayName, 'Alpha')
})

test('a folder called __proto__ is renamed like any other', () => {
  const map = rebuild(navMapFn({ '__proto__/index': 'Prototype' }))
  const folder = node('__proto__/index', { isFolder: true, displayName: '__proto__' })
  map(folder)
  assert.equal(folder.displayName, 'Prototype')
})

test('a name with a quote in it cannot break out of the source it is embedded in', () => {
  const name = 'It\'s "Quoted" \\ Done'
  const map = rebuild(navMapFn({ 'a/index': name }))
  const folder = node('a/index', { isFolder: true })
  map(folder)
  assert.equal(folder.displayName, name)
})

test('a slug with a quote in it cannot break out of the source it is embedded in', () => {
  const slug = 'it\'s/"quoted"'
  const sort = rebuild(navSortFn([slug, 'a']))
  assert.deepEqual(sorted(sort, [node('a'), node(slug)]), [slug, 'a'])
})
