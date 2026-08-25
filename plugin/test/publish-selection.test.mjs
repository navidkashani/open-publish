/**
 * What a tick actually does — one test per row of the table in the plan.
 *
 * These run through the real Publisher and read the snapshot it committed,
 * because the interesting failures are not in the selection arithmetic but in
 * what ends up describing the live site.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Publisher } from '../src/core/publisher.ts'
import { CURRENT_KEY, objectKey, parseSnapshot, snapshotKey } from '../src/core/snapshot.ts'
import { FakeDestination, bytes, site } from './helpers.mjs'

const H_KEEP = 'aa'.repeat(32)
const H_OLD = 'bb'.repeat(32)
const H_NEW = 'cc'.repeat(32)
const H_FRESH = 'dd'.repeat(32)
const H_DROP = 'ee'.repeat(32)

const file = (hash, slug) => ({ hash, size: 4, mtime: 1, slug })

/** The site as it stands: keep.md, edit.md at its old version, drop.md. */
const previous = {
  version: 1,
  id: '2026-01-01T00-00-00Z-aaaaaa',
  parent: null,
  createdAt: 1_600_000_000_000,
  generator: { plugin: 'open-publish', version: '0.1.0' },
  site,
  files: { 'keep.md': file(H_KEEP, 'keep'), 'edit.md': file(H_OLD, 'edit'), 'drop.md': file(H_DROP, 'drop') },
  links: { 'edit.md': [{ raw: 'drop', target: 'drop.md', status: 'published', slug: 'drop' }] },
  redirects: [],
}

/** The vault right now: edit.md edited, fresh.md written, drop.md no longer published. */
const scan = {
  snapshot: {
    version: 1,
    id: 'placeholder',
    parent: previous.id,
    createdAt: 1_700_000_000_000,
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site,
    files: { 'keep.md': file(H_KEEP, 'keep'), 'edit.md': file(H_NEW, 'edit'), 'fresh.md': file(H_FRESH, 'fresh') },
    links: { 'edit.md': [{ raw: 'fresh', target: 'fresh.md', status: 'published', slug: 'fresh' }] },
    redirects: [],
  },
  previous,
  currentEtag: 'etag-prev',
  isFirstPublish: false,
  added: ['fresh.md'],
  changed: ['edit.md'],
  unchanged: ['keep.md'],
  removed: ['drop.md'],
  renames: [],
  autoIncluded: new Set(),
  linkedButUnpublished: [],
  blockers: [],
  warnings: [],
  totalBytes: 12,
}

/** Everything the site already serves is in storage; the new bytes are not. */
function liveDestination({ keepOldObject = true } = {}) {
  const destination = new FakeDestination()
  const seed = [H_KEEP, H_DROP, ...(keepOldObject ? [H_OLD] : [])]
  for (const hash of seed) {
    destination.objects.set(objectKey(hash), { body: bytes('old'), etag: 'seed', lastModified: 0 })
  }
  destination.objects.set(CURRENT_KEY, {
    body: bytes(JSON.stringify({ version: 1, snapshot: previous.id, updatedAt: 0 })),
    etag: 'etag-prev',
    lastModified: 0,
  })
  destination.log.length = 0
  return destination
}

async function publish(selection, options = {}) {
  const destination = liveDestination(options)
  const outcome = await new Publisher().publish(
    {
      scan,
      selection,
      destination,
      builder: null,
      readFile: async () => bytes('current bytes'),
      site,
      pluginVersion: '0.1.0',
      autoTrigger: false,
      minIntervalMinutes: 0,
      lastBuildTriggeredAt: null,
    },
    () => {},
  )
  const snapshot = parseSnapshot(destination.text(snapshotKey(outcome.snapshotId)))
  return { outcome, snapshot, destination }
}

/** Everything ticked the way the window opens: publish both changes, remove nothing extra. */
const asOpened = {
  include: new Set(['fresh.md', 'edit.md', 'keep.md']),
  keepPrevious: new Set(),
}

test('new + ticked -> published', async () => {
  const { snapshot } = await publish(asOpened)
  assert.equal(snapshot.files['fresh.md'].hash, H_FRESH)
})

test('new + unticked -> left alone, and nothing is uploaded for it', async () => {
  const { snapshot, destination } = await publish({
    include: new Set(['edit.md', 'keep.md']),
    keepPrevious: new Set(),
  })
  assert.equal(snapshot.files['fresh.md'], undefined)
  assert.equal(destination.objects.has(objectKey(H_FRESH)), false)
})

test('changed + ticked -> updated', async () => {
  const { snapshot, destination } = await publish(asOpened)
  assert.equal(snapshot.files['edit.md'].hash, H_NEW)
  assert.ok(destination.objects.has(objectKey(H_NEW)), 'the new version reached storage')
})

test('changed + unticked -> the old version stays live, and the page is not lost', async () => {
  // The regression test. Unticking a changed file used to drop it from the
  // snapshot entirely, which reads as "remove this page" — so "not this edit
  // yet" silently deleted the note from the site.
  const { snapshot, outcome, destination } = await publish({
    include: new Set(['fresh.md', 'keep.md']),
    keepPrevious: new Set(['edit.md']),
  })

  assert.ok(snapshot.files['edit.md'], 'the page is still on the site')
  assert.equal(snapshot.files['edit.md'].hash, H_OLD, 'serving exactly what it served before')
  assert.equal(snapshot.files['edit.md'].slug, 'edit')
  assert.equal(destination.objects.has(objectKey(H_NEW)), false, 'and the new version was never uploaded')
  assert.equal(outcome.uploaded, 1, 'only the genuinely new file')
})

test('a file held at its published version keeps that version\'s links', async () => {
  // Its current text links to fresh.md; the version being served links to
  // drop.md. Emitting today's links for yesterday's page would put links on the
  // site that the page being served does not contain.
  const { snapshot } = await publish({
    include: new Set(['fresh.md', 'keep.md']),
    keepPrevious: new Set(['edit.md']),
  })
  const links = snapshot.links['edit.md']
  assert.equal(links.length, 1)
  assert.equal(links[0].target, 'drop.md')
  assert.equal(links[0].status, 'unpublished', 'and it knows that target is coming off the site')
  assert.equal(links[0].slug, undefined)
})

test('already published + untouched -> stays live', async () => {
  const { snapshot } = await publish(asOpened)
  assert.equal(snapshot.files['keep.md'].hash, H_KEEP)
})

test('already published + ticked -> taken off the site', async () => {
  const { snapshot } = await publish({
    include: new Set(['fresh.md', 'edit.md']),
    keepPrevious: new Set(),
  })
  assert.equal(snapshot.files['keep.md'], undefined)
})

test('removed -> taken off the site, whatever else is ticked', async () => {
  const { snapshot } = await publish(asOpened)
  assert.equal(snapshot.files['drop.md'], undefined)
})

test('unticking everything already published, and every change, empties the site', async () => {
  const { snapshot } = await publish({ include: new Set(), keepPrevious: new Set() })
  assert.deepEqual(Object.keys(snapshot.files), [])
})

test('holding a file back never re-uploads what is already there', async () => {
  const { outcome, destination } = await publish({
    include: new Set(['keep.md']),
    keepPrevious: new Set(['edit.md']),
  })
  assert.equal(outcome.uploaded, 0)
  assert.equal(outcome.skipped, 2)
  assert.equal(destination.writeOrder().filter((key) => key.startsWith('objects/')).length, 0)
})

test('if the published version has gone from storage, the current one is published instead', async () => {
  // Never upload today's bytes under yesterday's hash: content-addressed
  // storage is shared by every snapshot, so one wrong object corrupts history.
  const { snapshot, destination } = await publish(
    { include: new Set(['fresh.md', 'keep.md']), keepPrevious: new Set(['edit.md']) },
    { keepOldObject: false },
  )
  assert.equal(snapshot.files['edit.md'].hash, H_NEW, 'the page survives, at the version we actually have')
  assert.equal(
    destination.writeOrder().includes(objectKey(H_OLD)),
    false,
    'and nothing was written under the hash whose bytes are gone',
  )
  assert.ok(destination.objects.has(objectKey(H_NEW)))
})

test('the snapshot the site is pointed at is the one the ticks describe', async () => {
  const { outcome, destination } = await publish(asOpened)
  assert.equal(JSON.parse(destination.text(CURRENT_KEY)).snapshot, outcome.snapshotId)
  assert.equal(destination.writeOrder().at(-1), CURRENT_KEY)
})

test('republishing the same notes later does not spend a build', async () => {
  // The scan stamps a fresh `createdAt` every time, so the snapshot id always
  // differs. Detecting "no change" has to look at content, or this never fires
  // outside the same wall-clock second and every no-op costs a build.
  const unchanged = {
    ...scan,
    snapshot: { ...scan.snapshot, createdAt: Date.now(), files: previous.files, links: previous.links },
    added: [],
    changed: [],
    unchanged: Object.keys(previous.files),
    removed: [],
  }
  const destination = liveDestination()
  let triggered = false
  const outcome = await new Publisher().publish(
    {
      scan: unchanged,
      selection: { include: new Set(Object.keys(previous.files)), keepPrevious: new Set() },
      destination,
      builder: {
        id: 'x',
        test: async () => ({ ok: true }),
        trigger: async () => {
          triggered = true
          return { accepted: true }
        },
        waitForDeploy: async function* () {
          yield { state: 'live' }
        },
      },
      readFile: async () => bytes('x'),
      site,
      pluginVersion: '0.1.0',
      autoTrigger: true,
      minIntervalMinutes: 0,
      lastBuildTriggeredAt: null,
    },
    () => {},
  )

  assert.equal(outcome.committed, false)
  assert.equal(triggered, false)
  assert.equal(destination.log.length, 0, 'and it costs no network traffic at all')
})
