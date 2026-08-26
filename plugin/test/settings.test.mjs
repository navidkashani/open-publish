import test from 'node:test'
import assert from 'node:assert/strict'
import {
  migrateSettings,
  DEFAULT_SETTINGS,
  hasStorageMoved,
  isDestinationConfigured,
  isBuilderConfigured,
  storageTarget,
} from '../src/settings.ts'

test('a missing or empty data.json yields working defaults', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42]) {
    const settings = migrateSettings(input)
    assert.equal(settings.version, 1)
    assert.equal(settings.selection.autoIncludeEmbeds, true, 'auto-include is on by default')
    assert.equal(settings.destination.forcePathStyle, true)
    assert.equal(settings.builder.autoTrigger, true)
  }
})

test('migration does not mutate the defaults object', () => {
  const settings = migrateSettings({ site: { title: 'Changed' } })
  settings.selection.includes.push('Notes')
  assert.equal(DEFAULT_SETTINGS.site.title, 'My Notes')
  assert.deepEqual(DEFAULT_SETTINGS.selection.includes, [])
})

test('stored values survive, and unknown fields are dropped', () => {
  const settings = migrateSettings({
    version: 1,
    destination: { endpoint: 'https://e', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' },
    builder: { url: 'https://hook', siteUrl: 'https://site' },
    site: { title: 'Mine', showGraph: false },
    lastSnapshotId: 'snap-1',
    somethingFromTheFuture: { nested: true },
  })
  assert.equal(settings.destination.bucket, 'b')
  assert.equal(settings.site.title, 'Mine')
  assert.equal(settings.site.showGraph, false)
  assert.equal(settings.site.showSearch, true, 'untouched toggles keep their default')
  assert.equal(settings.lastSnapshotId, 'snap-1')
  assert.equal('somethingFromTheFuture' in settings, false)
})

test('folder rules are normalised and non-strings discarded', () => {
  const settings = migrateSettings({ selection: { includes: ['/Notes/', 'Blog', 42, null], excludes: ['/Private'] } })
  assert.deepEqual(settings.selection.includes, ['Notes', 'Blog'])
  assert.deepEqual(settings.selection.excludes, ['Private'])
})

test('a corrupted explicit map does not break selection', () => {
  const settings = migrateSettings({ selection: { explicit: { 'a.md': true, 'b.md': 'yes', 'c.md': null } } })
  assert.deepEqual(settings.selection.explicit, { 'a.md': true })
})

test('configuration checks require every field that a request needs', () => {
  const partial = migrateSettings({ destination: { endpoint: 'https://e', bucket: 'b' } })
  assert.equal(isDestinationConfigured(partial), false, 'no credentials yet')
  partial.destination.accessKeyId = 'k'
  partial.destination.secretAccessKey = 's'
  assert.equal(isDestinationConfigured(partial), true)

  assert.equal(isBuilderConfigured(migrateSettings({ builder: { url: 'https://hook' } })), false, 'a site URL is needed to verify')
  assert.equal(isBuilderConfigured(migrateSettings({ builder: { url: 'https://hook', siteUrl: 'https://s' } })), true)
})

test('new site options arrive with safe defaults, never undefined', () => {
  // A data.json written before these options existed must not switch features off.
  const settings = migrateSettings({ version: 1, site: { title: 'Old vault', showGraph: false } })
  assert.equal(settings.site.title, 'Old vault')
  assert.equal(settings.site.showGraph, false, 'the stored choice survives')
  assert.equal(settings.site.showSearch, true)
  assert.equal(settings.site.showNavigation, true)
  assert.equal(settings.site.showThemeToggle, true)
  assert.equal(settings.site.noIndex, false)
  assert.equal(settings.site.homepage, '')
  assert.equal(settings.site.strictLineBreaks, false, 'off by default: notes use single line breaks')
  assert.deepEqual(settings.site.analytics, { provider: 'none', id: '' })
})

test('a half-written analytics block cannot lose its provider', () => {
  assert.deepEqual(migrateSettings({ site: { analytics: { id: 'G-123' } } }).site.analytics, {
    provider: 'none',
    id: 'G-123',
  })
  assert.deepEqual(migrateSettings({ site: { analytics: { provider: 'google', id: 'G-123' } } }).site.analytics, {
    provider: 'google',
    id: 'G-123',
  })
  assert.deepEqual(migrateSettings({ site: {} }).site.analytics, { provider: 'none', id: '' })
})

// --- the storage provider label ------------------------------------------

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'

test('an existing R2 config is recognised without a single byte of it changing', () => {
  const stored = {
    destination: {
      endpoint: R2_ENDPOINT,
      bucket: 'my-notes',
      region: 'auto',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    },
  }
  const settings = migrateSettings(stored)
  assert.equal(settings.destination.provider, 'r2')
  assert.equal(settings.destination.endpoint, R2_ENDPOINT, 'byte-identical to what was in the box')
  assert.equal(settings.destination.region, 'auto')
  assert.equal(settings.destination.forcePathStyle, true)
})

test('a trailing slash is still recognised, since the signer already ignores one', () => {
  assert.equal(migrateSettings({ destination: { endpoint: `${R2_ENDPOINT}/` } }).destination.provider, 'r2')
})

test('a custom domain in front of a bucket is Other, and nothing is rewritten', () => {
  // Scenario 3: the endpoint does not match the template, so inference must not
  // guess. Migration is read-only.
  const settings = migrateSettings({
    destination: { endpoint: 'https://files.example.com', bucket: 'b', region: 'auto', forcePathStyle: true },
  })
  assert.equal(settings.destination.provider, 'other')
  assert.equal(settings.destination.endpoint, 'https://files.example.com')
})

test('migration never flips path-style, whatever the provider default is', () => {
  // AWS is virtual-host in the catalogue, but somebody already publishing with
  // path-style on is publishing successfully, and that outranks the catalogue.
  const settings = migrateSettings({
    destination: { endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'b', forcePathStyle: true },
  })
  assert.equal(settings.destination.provider, 'aws')
  assert.equal(settings.destination.forcePathStyle, true, 'a working configuration is left alone')

  const off = migrateSettings({ destination: { endpoint: R2_ENDPOINT, forcePathStyle: false } })
  assert.equal(off.destination.forcePathStyle, false, 'and so is a deliberately unusual one')
})

test('a vault that has never been set up opens on the recommended provider', () => {
  assert.equal(migrateSettings({}).destination.provider, 'r2')
  assert.equal(migrateSettings({ destination: { endpoint: '   ' } }).destination.provider, 'r2')
})

test('a stored provider survives a round trip through an older build', () => {
  // An older build merges the destination with `Object.assign`, so a key it has
  // never heard of passes straight through. This is what makes the field safe
  // to add: a downgrade and an upgrade leave it where it was.
  const mine = migrateSettings({ destination: { endpoint: R2_ENDPOINT, provider: 'wasabi' } })
  assert.equal(mine.destination.provider, 'wasabi', 'an explicit choice outranks what the endpoint looks like')

  const throughOldBuild = JSON.parse(JSON.stringify(mine))
  assert.equal(migrateSettings(throughOldBuild).destination.provider, 'wasabi')
})

test('a provider id from the future is re-inferred rather than kept unrenderable', () => {
  const settings = migrateSettings({ destination: { endpoint: R2_ENDPOINT, provider: 'tigris' } })
  assert.equal(settings.destination.provider, 'r2')
  assert.equal(settings.destination.endpoint, R2_ENDPOINT, 'the endpoint is the source of truth either way')
})

test('migration is idempotent, or a synced data.json would churn on every keystroke', () => {
  // `saveSettings()` runs on every character typed into a text field. A
  // migration that rewrote anything would rewrite it forever.
  const once = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
    lastSnapshotId: 'snap-1',
    lastPublishedAt: 1700000000000,
  })
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(once))), once)
})

// --- where the last publish went ----------------------------------------

test('the storage target ignores cosmetic edits, and notices real ones', () => {
  const base = { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: '', forcePathStyle: true }
  assert.equal(storageTarget(base), storageTarget({ ...base, endpoint: `${R2_ENDPOINT}/` }))
  assert.equal(storageTarget(base), storageTarget({ ...base, prefix: '/' }))
  assert.notEqual(storageTarget(base), storageTarget({ ...base, bucket: 'other-notes' }))
  assert.notEqual(storageTarget(base), storageTarget({ ...base, prefix: 'notes' }))
  assert.notEqual(storageTarget(base), storageTarget({ ...base, forcePathStyle: false }))
})

test('the region is not part of the target: it signs a request, it does not address one', () => {
  const base = { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: '', forcePathStyle: true }
  assert.equal(storageTarget({ ...base, region: 'auto' }), storageTarget({ ...base, region: 'us-east-1' }))
})

test('a vault that published before this field existed is credited with its own settings', () => {
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretAccessKey: 's' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(settings.lastPublishedTarget, storageTarget(settings.destination))
  assert.equal(hasStorageMoved(settings), false, 'nothing has moved, so nothing is said')
})

test('publishing to one bucket and then pointing at another is called out', () => {
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretAccessKey: 's' },
    lastSnapshotId: 'snap-1',
  })
  settings.destination.bucket = 'a-different-bucket'
  assert.equal(hasStorageMoved(settings), true)
})

test('nothing is claimed before the first publish, or before storage is filled in', () => {
  const neverPublished = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' },
  })
  assert.equal(hasStorageMoved(neverPublished), false)

  const halfTyped = migrateSettings({ lastSnapshotId: 'snap-1', lastPublishedTarget: 'something|else||path' })
  assert.equal(hasStorageMoved(halfTyped), false, 'a half-typed endpoint is not a migration')
})
