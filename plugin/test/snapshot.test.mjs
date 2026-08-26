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

const site = { title: 'N', homepage: '', noIndex: false, showThemeToggle: true, strictLineBreaks: false,
  showNavigation: true, showSearch: true, showGraph: true, showOutline: true, showBacklinks: true, showTags: true,
  analytics: { provider: 'none', id: '' } }
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

test('a rename is detected by matching content hash and emits a redirect', () => {
  const previous = snapshot({ 'Notes/Old Name.md': file('h1', 'notes/old-name') })
  const { renames, redirects } = detectRenames(previous, { 'Notes/Zettelkasten.md': file('h1', 'notes/zettelkasten') })
  assert.deepEqual(renames, [{ from: 'Notes/Old Name.md', to: 'Notes/Zettelkasten.md' }])
  assert.deepEqual(redirects, [{ from: 'notes/old-name', to: 'notes/zettelkasten' }])
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
    noIndex: { ...site, noIndex: true },
    showThemeToggle: { ...site, showThemeToggle: false },
    strictLineBreaks: { ...site, strictLineBreaks: true },
    showNavigation: { ...site, showNavigation: false },
    showSearch: { ...site, showSearch: false },
    showGraph: { ...site, showGraph: false },
    showOutline: { ...site, showOutline: false },
    showBacklinks: { ...site, showBacklinks: false },
    showTags: { ...site, showTags: false },
    analytics: { ...site, analytics: { provider: 'google', id: 'G-1' } },
  }
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
