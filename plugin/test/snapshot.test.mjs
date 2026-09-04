import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeSnapshotId,
  detectRenames,
  diffFiles,
  parseSnapshot,
  parseCurrentPointer,
  objectKey,
  sameContent,
  snapshotContentKey,
  MAX_REDIRECTS,
} from '../src/core/snapshot.ts'
import { DEFAULT_SETTINGS } from '../src/settings.ts'

/**
 * The plugin's own defaults rather than a copy of them, so that `Object.keys`
 * below is the real key set of `SnapshotSite`. Written out, this block went
 * stale silently: the completeness check under `variants` would compare a
 * hand-maintained map against a hand-maintained object and find them in
 * perfect agreement about an option neither had heard of.
 */
const site = { ...DEFAULT_SETTINGS.site, title: 'N' }
const file = (hash, slug, extra = {}) => ({ hash, size: 1, mtime: 0, slug, ...extra })

const snapshot = (files, overrides = {}) => ({
  version: 1,
  id: 'prev',
  parent: null,
  createdAt: 0,
  generator: { plugin: 'open-publish', version: '0.1.0' },
  site,
  files,
  links: {},
  redirects: [],
  ...overrides,
})

test('objects are sharded by the first two hex characters', () => {
  assert.equal(objectKey('abcdef0123'), 'objects/ab/abcdef0123')
})

test('the same content in the same second produces the same id: retries are idempotent', async () => {
  const files = { 'a.md': file('h1', 'a') }
  assert.equal(await computeSnapshotId(files, site, 1000), await computeSnapshotId(files, site, 1000))
})

test('changing only a site toggle produces a new id, so a rebuild still happens', async () => {
  const files = { 'a.md': file('h1', 'a') }
  const before = await computeSnapshotId(files, site, 1000)
  const after = await computeSnapshotId(files, { ...site, showGraph: false }, 1000)
  assert.notEqual(before, after)
})

test('id ignores mtime, so touching a file without editing it does not rebuild', async () => {
  const a = await computeSnapshotId({ 'a.md': file('h1', 'a', { mtime: 1 }) }, site, 1000)
  const b = await computeSnapshotId({ 'a.md': file('h1', 'a', { mtime: 999999 }) }, site, 1000)
  assert.equal(a, b)
})

test('id ignores ctime too, so a restored vault does not rebuild the whole site', async () => {
  // `ctime` comes off the filesystem, and sync, a restore from backup or a
  // plain file transfer resets it on every file at once. In the content key
  // that would be a full rebuild triggered by a copy operation.
  const a = await computeSnapshotId({ 'a.md': file('h1', 'a', { ctime: 1 }) }, site, 1000)
  const b = await computeSnapshotId({ 'a.md': file('h1', 'a', { ctime: 999999 }) }, site, 1000)
  assert.equal(a, b)
  assert.equal(
    snapshotContentKey({ 'a.md': file('h1', 'a', { ctime: 1 }) }, site),
    snapshotContentKey({ 'a.md': file('h1', 'a') }, site),
    'a snapshot written before ctime existed must compare equal to one written after',
  )
})

test('ids sort chronologically', async () => {
  const early = await computeSnapshotId({}, site, Date.UTC(2026, 0, 1))
  const late = await computeSnapshotId({}, site, Date.UTC(2026, 5, 1))
  assert.ok(early < late)
  assert.match(early, /^2026-01-01T00-00-00Z-[0-9a-f]{6}$/)
})

test('diff classifies every path', () => {
  const previous = snapshot({ 'keep.md': file('h1', 'keep'), 'edit.md': file('h2', 'edit'), 'gone.md': file('h3', 'gone') })
  const next = { 'keep.md': file('h1', 'keep'), 'edit.md': file('h2-new', 'edit'), 'new.md': file('h4', 'new') }
  const diff = diffFiles(previous, next)
  assert.deepEqual(diff, { added: ['new.md'], changed: ['edit.md'], unchanged: ['keep.md'], removed: ['gone.md'] })
})

test('a slug change counts as changed even when the bytes are identical', () => {
  const previous = snapshot({ 'a.md': file('h1', 'old-slug') })
  const diff = diffFiles(previous, { 'a.md': file('h1', 'new-slug') })
  assert.deepEqual(diff.changed, ['a.md'])
})

test('turning on old URLs is a change to every file it touches', () => {
  // Same bytes, same slug, a redirect page each. Without this the review screen
  // greys out its own button over the change the user just asked for.
  const previous = snapshot({ 'Company/About us.md': file('h1', 'company/about-us') })
  const next = { 'Company/About us.md': file('h1', 'company/about-us', { legacyUrls: ['Company/About+us'] }) }
  assert.deepEqual(diffFiles(previous, next).changed, ['Company/About us.md'])
  assert.equal(sameContent(previous, snapshot(next)), false, 'so the publish is not skipped as a no-op')
  assert.equal(sameContent(snapshot(next), snapshot(next)), true, 'and the publish after it is')
})

test('a rename is detected by matching content hash and emits a redirect', () => {
  const previous = snapshot({ 'Notes/Old Name.md': file('h1', 'notes/old-name') })
  const { renames, redirects } = detectRenames(previous, { 'Notes/Zettelkasten.md': file('h1', 'notes/zettelkasten') })
  assert.deepEqual(renames, [{ from: 'Notes/Old Name.md', to: 'Notes/Zettelkasten.md' }])
  assert.deepEqual(redirects, [{ from: 'notes/old-name', to: 'notes/zettelkasten' }])
})

test('a note that stays put but changes slug still redirects its old URL', () => {
  // The everyday way to hit this is editing `permalink`, which moves the URL and
  // changes the bytes, so the rename detector cannot see it: that one only looks
  // at paths which disappeared. Without a redirect the old URL 404s silently.
  const previous = snapshot({ 'Notes/Thing.md': file('h1', 'notes/thing') })
  const { renames, redirects } = detectRenames(previous, { 'Notes/Thing.md': file('h2', 'my-thing') })

  assert.deepEqual(redirects, [{ from: 'notes/thing', to: 'my-thing' }])
  assert.deepEqual(renames, [], 'nothing was renamed: the file never moved')
})

test('the same holds when the bytes are identical, which is what a slug-scheme change is', () => {
  // This is what makes changing the whole URL scheme reversible rather than a
  // one-way door: every page carries a redirect from where it used to live.
  const previous = snapshot({ 'a.md': file('h1', 'old/a'), 'b.md': file('h2', 'old/b') })
  const { redirects } = detectRenames(previous, { 'a.md': file('h1', 'new-a'), 'b.md': file('h2', 'new-b') })

  assert.deepEqual(redirects.sort((x, y) => x.from.localeCompare(y.from)), [
    { from: 'old/a', to: 'new-a' },
    { from: 'old/b', to: 'new-b' },
  ])
})

test('a slug that did not move emits nothing', () => {
  const previous = snapshot({ 'a.md': file('h1', 'a') })
  assert.deepEqual(detectRenames(previous, { 'a.md': file('h2', 'a') }).redirects, [])
})

/**
 * Promoting a note to the homepage, which is the one redirect a starter cannot
 * work out for itself and the one most easily lost.
 *
 * The plugin applies `site.homepage` by giving that note the slug `index`. To a
 * generator that is a note sitting at the site root with no history: under
 * `slugs: 'preserve'` it is even written to disk *at* `index.md`, so every
 * vacated-slug rule a generator has short-circuits (`from === to`), and `index`
 * is not a URL to redirect from anyway. The rule below is the *only* thing
 * carrying the note's old address across, and without it every link anybody
 * ever published to the note that is now the front page 404s, silently.
 */
test('promoting a note to the homepage carries its old URL across', () => {
  const previous = snapshot({ 'Welcome.md': file('h1', 'welcome') })
  const { redirects } = detectRenames(previous, { 'Welcome.md': file('h1', 'index') })
  assert.deepEqual(redirects, [{ from: 'welcome', to: 'index' }])
})

test('and a homepage set on a first publish emits none, because nothing served it', () => {
  // Deliberate rather than accidental: there is no previous snapshot, so there
  // is no address anybody could have published, and a redirect from a URL that
  // never existed is a rule that can only ever shadow a real page later.
  assert.deepEqual(detectRenames(null, { 'Welcome.md': file('h1', 'index') }), {
    redirects: [],
    renames: [],
  })
})

test('demoting the homepage again redirects / to wherever the note went', () => {
  // The reverse move has to work too, or turning the setting off strands every
  // link to the site root that was published while it was on.
  const previous = snapshot({ 'Welcome.md': file('h1', 'index') })
  const { redirects } = detectRenames(previous, { 'Welcome.md': file('h1', 'welcome') })
  assert.deepEqual(redirects, [{ from: 'index', to: 'welcome' }])
})

test('a slug changed twice collapses to one hop, same as a rename does', () => {
  const previous = snapshot({ 'a.md': file('h1', 'second') }, { redirects: [{ from: 'first', to: 'second' }] })
  const { redirects } = detectRenames(previous, { 'a.md': file('h2', 'third') })

  assert.deepEqual(redirects.sort((x, y) => x.from.localeCompare(y.from)), [
    { from: 'first', to: 'third' },
    { from: 'second', to: 'third' },
  ])
})

test('a move that keeps the filename is preferred over an unrelated same-hash file', () => {
  const previous = snapshot({
    'A/note.md': file('h1', 'a/note'),
    'Z/other.md': file('h1', 'z/other'),
  })
  const { renames } = detectRenames(previous, { 'B/note.md': file('h1', 'b/note'), 'Z/other.md': file('h1', 'z/other') })
  assert.deepEqual(renames, [{ from: 'A/note.md', to: 'B/note.md' }])
})

test('renaming twice keeps both old URLs working and collapses the chain', () => {
  // a -> b happened last time; now b -> c. Visitors on /a must reach /c in one hop.
  const previous = snapshot({ 'b.md': file('h1', 'b') }, { redirects: [{ from: 'a', to: 'b' }] })
  const { redirects } = detectRenames(previous, { 'c.md': file('h1', 'c') })
  assert.deepEqual(redirects.sort((x, y) => x.from.localeCompare(y.from)), [
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ])
})

test('a redirect cycle cannot hang the scan', () => {
  const previous = snapshot({ 'a.md': file('h1', 'a'), 'b.md': file('h2', 'b') }, {
    redirects: [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }],
  })
  const { redirects } = detectRenames(previous, { 'b.md': file('h1', 'b'), 'a.md': file('h2', 'a') })
  assert.ok(Array.isArray(redirects))
})

test('redirects are capped at the platform limit', () => {
  const files = {}
  const redirects = []
  for (let i = 0; i < MAX_REDIRECTS + 50; i++) redirects.push({ from: `old-${i}`, to: 'target' })
  const previous = snapshot(files, { redirects })
  const { redirects: out } = detectRenames(previous, {})
  assert.equal(out.length, MAX_REDIRECTS)
})

test('a truncated snapshot is rejected rather than half-read', () => {
  assert.throws(() => parseSnapshot('{"version":1,"id":"x","fil'), /not valid JSON/)
  assert.throws(() => parseSnapshot(JSON.stringify({ version: 2, id: 'x', files: {} })), /Unsupported snapshot version/)
  assert.throws(() => parseSnapshot(JSON.stringify({ version: 1, id: 'x' })), /missing required fields/)
})

test('a pointer without a snapshot id is rejected', () => {
  assert.throws(() => parseCurrentPointer('{"version":1}'), /missing a snapshot ID/)
  assert.equal(parseCurrentPointer('{"version":1,"snapshot":"s1","updatedAt":5}').snapshot, 's1')
})

test('every site option affects the snapshot id, so flipping one triggers a rebuild', async () => {
  const files = { 'a.md': file('h1', 'a') }
  const base = await computeSnapshotId(files, site, 1000)

  const variants = {
    title: { ...site, title: 'Other' },
    homepage: { ...site, homepage: 'Notes/Home.md' },
    // The pair that makes a Persian vault a different site from an English one:
    // a wrong `lang` is not cosmetic, so neither may be free to skip a rebuild.
    locale: { ...site, locale: 'fa-IR' },
    dir: { ...site, dir: 'rtl' },
    noIndex: { ...site, noIndex: true },
    showThemeToggle: { ...site, showThemeToggle: false },
    strictLineBreaks: { ...site, strictLineBreaks: true },
    showNavigation: { ...site, showNavigation: false },
    showSearch: { ...site, showSearch: false },
    showGraph: { ...site, showGraph: false },
    showOutline: { ...site, showOutline: false },
    showBacklinks: { ...site, showBacklinks: false },
    showTags: { ...site, showTags: false },
    showPageMetadata: { ...site, showPageMetadata: true },
    showPrevNext: { ...site, showPrevNext: false },
    showHoverPreview: { ...site, showHoverPreview: false },
    showInlineTitle: { ...site, showInlineTitle: false },
    // Rearranging the sidebar changes no note and no slug, so without this the
    // publish that carries it would find nothing to do and spend no build: the
    // order would sit in data.json and never reach the site.
    nav: { ...site, nav: { order: ['notes/index', 'a'], hidden: [] } },
    analytics: { ...site, analytics: { provider: 'google', id: 'G-1' } },
  }
  /**
   * The map above is written out by hand, so this is what stops it going stale:
   * a site option added to `SnapshotSite` and not to `variants` would leave
   * this test green while the option it forgot rode along in every snapshot
   * without ever triggering a rebuild.
   */
  assert.deepEqual(
    Object.keys(variants).sort(),
    Object.keys(site).sort(),
    'every key of SnapshotSite needs a variant here, or it is not being tested at all',
  )

  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(await computeSnapshotId(files, variant, 1000), base, `${name} did not change the id`)
  }
})

test('"nothing changed" compares content, not ids: ids carry a timestamp', () => {
  // Publishing the same notes an hour later produces a different id but must
  // still count as no change, or every no-op publish spends a build.
  const files = { 'a.md': file('h1', 'a') }
  const morning = snapshot(files, { id: '2026-01-01T09-00-00Z-abc123', createdAt: 1 })
  const evening = snapshot(files, { id: '2026-01-01T21-00-00Z-abc123', createdAt: 2 })
  assert.notEqual(morning.id, evening.id)
  assert.equal(sameContent(morning, evening), true)
})

test('sameContent notices anything that would change the site', () => {
  const base = snapshot({ 'a.md': file('h1', 'a') })
  assert.equal(sameContent(base, snapshot({ 'a.md': file('h2', 'a') })), false, 'edited')
  assert.equal(sameContent(base, snapshot({ 'a.md': file('h1', 'moved') })), false, 'moved')
  assert.equal(sameContent(base, snapshot({ 'a.md': file('h1', 'a'), 'b.md': file('h2', 'b') })), false, 'added')
  assert.equal(sameContent(base, snapshot({})), false, 'removed')
  assert.equal(sameContent(base, snapshot({ 'a.md': file('h1', 'a') }, { site: { ...site, showGraph: false } })), false, 'site option')
})

test('sameContent ignores what the reader cannot see', () => {
  const base = snapshot({ 'a.md': file('h1', 'a', { mtime: 1, size: 10 }) })
  const touched = snapshot({ 'a.md': file('h1', 'a', { mtime: 999, size: 10 }) })
  assert.equal(sameContent(base, touched), true)
  assert.equal(sameContent(base, null), false, 'and a site that does not exist yet is never a match')
})

test('the content key does not depend on the order keys were written in', () => {
  const reordered = { analytics: { id: '', provider: 'none' }, ...site }
  assert.equal(snapshotContentKey({}, site), snapshotContentKey({}, reordered))
})

test('an entry missing the fields the rest of the plugin trusts is rejected', () => {
  // The hash decides what garbage collection may delete and the slug decides
  // where the page lives, so neither may arrive as undefined.
  const base = { version: 1, id: 'x', site, links: {}, redirects: [] }
  assert.throws(
    () => parseSnapshot(JSON.stringify({ ...base, files: { 'a.md': { size: 1, slug: 'a' } } })),
    /entry for "a.md" is incomplete/,
  )
  assert.throws(
    () => parseSnapshot(JSON.stringify({ ...base, files: { 'a.md': { hash: 'h1', size: 1 } } })),
    /entry for "a.md" is incomplete/,
  )
  assert.throws(() => parseSnapshot(JSON.stringify({ version: 1, id: 'x', files: {} })), /missing its site block/)
  assert.equal(parseSnapshot(JSON.stringify({ ...base, files: { 'a.md': file('h1', 'a') } })).id, 'x')
})
