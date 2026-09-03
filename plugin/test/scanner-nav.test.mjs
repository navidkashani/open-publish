/**
 * The seam where the manager's answer becomes the site's.
 *
 * Settings hold vault paths; a snapshot holds slugs. The conversion happens once,
 * in the scan, and nothing else in the plugin knows both vocabularies. So this
 * checks the crossing itself: that a snapshot never carries a vault path, that a
 * vault which never opened the manager carries no navigation at all, and that a
 * rename is reported back rather than quietly losing somebody's order.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeDestination, bytes, site } from './helpers.mjs'
const { TFile, scanVault } = await import('./harness.mjs')
const { CURRENT_KEY, snapshotKey } = await import('../src/core/snapshot.ts')

/** Hashes by path, so a test can say "this file changed" by saying so. */
const fakeHasher = (hashes) => ({
  async hash(file) {
    return hashes[file.path] ?? `hash-${file.path}`
  },
  prune() {},
})

function fakeVault(paths, frontmatter = {}) {
  const files = paths.map((path) => {
    const file = new TFile(path)
    file.stat = { size: 1, mtime: 0, ctime: 0 }
    return file
  })
  return {
    vault: { getFiles: () => files },
    metadataCache: {
      getCache: (path) => (frontmatter[path] ? { frontmatter: frontmatter[path] } : null),
      getFirstLinkpathDest: () => null,
    },
  }
}

async function scan({ paths, frontmatter = {}, nav, hashes = {}, previous = null, homepage = '' }) {
  const destination = new FakeDestination()
  if (previous) {
    await destination.put(snapshotKey(previous.id), bytes(JSON.stringify(previous)))
    await destination.put(CURRENT_KEY, bytes(JSON.stringify({ version: 1, snapshot: previous.id, updatedAt: 0 })))
  }
  return scanVault({
    app: fakeVault(paths, frontmatter),
    destination,
    hasher: fakeHasher(hashes),
    rules: { includes: [''], excludes: [], explicit: {} },
    site: { ...site, homepage, ...(nav ? { nav } : {}) },
    autoIncludeEmbeds: false,
    urlStyle: 'clean',
    pluginVersion: '0.1.0',
  })
}

test('a vault that never arranged anything publishes no navigation block at all', async () => {
  const result = await scan({ paths: ['Apple.md', 'Notes/Alpha.md'] })
  assert.equal('nav' in result.snapshot.site, false)
})

test('the manager stores vault paths and the snapshot carries slugs', async () => {
  const result = await scan({
    paths: ['Apple Pie.md', 'Zebra.md', 'Notes/Alpha.md'],
    nav: { order: ['Zebra.md', 'Apple Pie.md'], hidden: ['Notes'] },
  })
  assert.deepEqual(result.snapshot.site.nav, {
    order: ['zebra', 'apple-pie'],
    hidden: ['notes/index'],
  })
})

test('a note that states its own place beats the manager, all the way into the snapshot', async () => {
  const result = await scan({
    paths: ['Apple.md', 'Zebra.md'],
    frontmatter: { 'Zebra.md': { 'nav-order': 1 } },
    nav: { order: ['Apple.md', 'Zebra.md'], hidden: [] },
  })
  assert.deepEqual(result.snapshot.site.nav.order, ['zebra', 'apple'])
})

test('the homepage reaches the snapshot as `index`, which is the slug it is served at', async () => {
  // The one row whose slug the scan decides rather than derives. It is a
  // sibling of the other root notes on a site that lists it, and inert on one
  // that does not, so the plugin states it either way.
  const result = await scan({
    paths: ['Welcome.md', 'Now.md', 'Start here.md'],
    homepage: 'Welcome.md',
    nav: { order: ['Now.md', 'Welcome.md', 'Start here.md'], hidden: [] },
  })
  assert.deepEqual(result.snapshot.site.nav.order, ['now', 'index', 'start-here'])
})

test('an attachment is never offered a place, because a sidebar has no row for one', async () => {
  const result = await scan({
    paths: ['Apple.md', 'Diagram.png'],
    nav: { order: ['Diagram.png'], hidden: ['Diagram.png'] },
  })
  // Naming an attachment says nothing about any sidebar, so nothing is carried.
  assert.equal('nav' in result.snapshot.site, false)
  assert.ok(result.snapshot.files['Diagram.png'], 'and it is still published')
})

test('arranging the sidebar changes the snapshot id, so the site really is rebuilt', async () => {
  const plain = await scan({ paths: ['Apple.md', 'Zebra.md'] })
  const arranged = await scan({
    paths: ['Apple.md', 'Zebra.md'],
    nav: { order: ['Zebra.md', 'Apple.md'], hidden: [] },
  })
  assert.notEqual(plain.snapshot.id, arranged.snapshot.id)
})

test('a renamed note is reported back with its place followed, and settings are left alone', async () => {
  const previous = {
    version: 1,
    id: '2026-08-14T09-12-00Z-aaaaaa',
    parent: null,
    createdAt: 0,
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site,
    files: { 'Old.md': { hash: 'shared', size: 1, mtime: 0, slug: 'old' } },
    links: {},
    redirects: [],
  }
  const stored = { order: ['Old.md', 'Apple.md'], hidden: [] }
  const result = await scan({
    paths: ['New.md', 'Apple.md'],
    nav: stored,
    hashes: { 'New.md': 'shared' },
    previous,
  })

  assert.deepEqual(result.renames, [{ from: 'Old.md', to: 'New.md' }])
  assert.deepEqual(result.navRenamed, { order: ['New.md', 'Apple.md'], hidden: [] })
  assert.deepEqual(stored.order, ['Old.md', 'Apple.md'], 'a scan is a question; saving is the caller\'s job')
  // And the snapshot already uses the followed order, so the publish that
  // carries the rename carries the arrangement that survived it.
  assert.deepEqual(result.snapshot.site.nav.order, ['new', 'apple'])
})

test('a folder rename is followed only when the old folder really is gone', async () => {
  const previous = {
    version: 1,
    id: '2026-08-14T09-12-00Z-aaaaaa',
    parent: null,
    createdAt: 0,
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site,
    files: {
      'Notes/Alpha.md': { hash: 'alpha', size: 1, mtime: 0, slug: 'notes/alpha' },
      'Notes/Beta.md': { hash: 'beta', size: 1, mtime: 0, slug: 'notes/beta' },
    },
    links: {},
    redirects: [],
  }
  const hashes = { 'Journal/Alpha.md': 'alpha', 'Journal/Beta.md': 'beta', 'Notes/Beta.md': 'beta' }

  const emptied = await scan({
    paths: ['Journal/Alpha.md', 'Journal/Beta.md'],
    nav: { order: ['Notes'], hidden: [] },
    hashes,
    previous,
  })
  assert.deepEqual(emptied.navRenamed, { order: ['Journal'], hidden: [] })

  // One note moved out and the folder is still publishing. That is not a folder
  // rename, and treating it as one would rearrange a folder nobody touched.
  const partial = await scan({
    paths: ['Journal/Alpha.md', 'Notes/Beta.md'],
    nav: { order: ['Notes'], hidden: [] },
    hashes,
    previous,
  })
  assert.equal(partial.navRenamed, null)
})

test('nothing renamed means nothing for the caller to save', async () => {
  const result = await scan({ paths: ['Apple.md'], nav: { order: ['Apple.md'], hidden: [] } })
  assert.equal(result.navRenamed, null)
})

test('the settings block handed in is never mutated on its way into a snapshot', async () => {
  const nav = { order: ['Zebra.md', 'Apple.md'], hidden: [] }
  const result = await scan({ paths: ['Apple.md', 'Zebra.md'], nav })
  assert.deepEqual(nav.order, ['Zebra.md', 'Apple.md'])
  assert.notEqual(result.snapshot.site.nav, nav)
})
