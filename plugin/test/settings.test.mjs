import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateSettings, DEFAULT_SETTINGS, isDestinationConfigured, isBuilderConfigured } from '../src/settings.ts'

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
