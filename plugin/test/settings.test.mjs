import test from 'node:test'
import assert from 'node:assert/strict'
import {
  migrateSettings,
  recordPublish,
  DEFAULT_SETTINGS,
  hasHostMoved,
  hasStorageMoved,
  hostTarget,
  isDestinationConfigured,
  isBuilderConfigured,
  isRolledBack,
  rollbackWarning,
  storageMovedWarning,
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
    destination: { endpoint: 'https://e', bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret', region: 'auto' },
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
  // The name of a keychain entry, not the key. Whether this device still holds
  // an entry by that name is deliberately not asked here: this file imports
  // nothing from Obsidian, and `main.ts` is where resolution lives.
  partial.destination.secretRef = 'op-r2-secret'
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
  assert.equal(settings.site.showPrevNext, true)
  assert.equal(
    settings.site.showPageMetadata,
    false,
    'off by default, the way Obsidian Publish is: a guessed created date is worse than none',
  )
  assert.deepEqual(settings.site.analytics, { provider: 'none', id: '' })

  /**
   * And the general rule the assertions above are instances of. A site option
   * added to `DEFAULT_SETTINGS` without a line in `migrateSettings` arrives
   * `undefined` on every vault that has published before, which is falsy: the
   * feature switches itself off on somebody's live site with nothing said.
   */
  for (const key of Object.keys(DEFAULT_SETTINGS.site)) {
    assert.notEqual(settings.site[key], undefined, `site.${key} survived no migration`)
  }
})

test('a data.json written before navigation could be arranged gets both lists, not undefined', () => {
  const settings = migrateSettings({ version: 1, site: { title: 'Old vault' } })
  assert.deepEqual(settings.site.nav, { order: [], hidden: [] })
})

test('a corrupted navigation block cannot reach the manager or the snapshot', () => {
  // Hand-edited, half-synced, or written by a version that is not this one. The
  // manager renders these and the scan resolves them, and both would fail in a
  // way that names neither the file nor the cause.
  const settings = migrateSettings({
    site: { nav: { order: ['Notes/A.md', 42, null, 'Notes/B.md'], hidden: 'Notes/C.md' } },
  })
  assert.deepEqual(settings.site.nav, { order: ['Notes/A.md', 'Notes/B.md'], hidden: [] })
  assert.deepEqual(migrateSettings({ site: { nav: 'nonsense' } }).site.nav, { order: [], hidden: [] })
})

test('an arrangement survives a load, because it is the only copy of it', () => {
  const nav = { order: ['Notes', 'Apple.md'], hidden: ['Notes/Secret.md'] }
  assert.deepEqual(migrateSettings({ site: { nav } }).site.nav, nav)
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
      secretRef: 'op-r2-secret',
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
    destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' },
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
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(settings.lastPublishedTarget, storageTarget(settings.destination))
  assert.equal(hasStorageMoved(settings), false, 'nothing has moved, so nothing is said')
})

test('publishing to one bucket and then pointing at another is called out', () => {
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  settings.destination.bucket = 'a-different-bucket'
  assert.equal(hasStorageMoved(settings), true)
})

test('nothing is claimed before the first publish, or before storage is filled in', () => {
  const neverPublished = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' },
  })
  assert.equal(hasStorageMoved(neverPublished), false)

  const halfTyped = migrateSettings({ lastSnapshotId: 'snap-1', lastPublishedTarget: 'something|else||path' })
  assert.equal(hasStorageMoved(halfTyped), false, 'a half-typed endpoint is not a migration')
})

// --- the hosting label ---------------------------------------------------

const NETLIFY_HOOK = 'https://api.netlify.com/build_hooks/68a1f0c2d3e4b5a6c7d8e9f0'
const PAGES_HOOK = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/0f7a1c2e3b4d5e6f'

test('a stored Netlify hook is recognised without a byte of the build settings changing', () => {
  // The number that matters most here is the one we must not touch. It governs
  // how often somebody spends an allowance of roughly 20 a month, and a guess
  // is no basis for changing it.
  const stored = {
    builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app', minIntervalMinutes: 17, autoTrigger: false },
  }
  const settings = migrateSettings(stored)
  assert.equal(settings.builder.host, 'netlify')
  assert.equal(settings.builder.url, NETLIFY_HOOK, 'byte-identical to what was in the box')
  assert.equal(settings.builder.minIntervalMinutes, 17, 'never rewritten from an inference')
  assert.equal(settings.builder.autoTrigger, false)
})

test('an existing Pages user is labelled correctly rather than accidentally', () => {
  const settings = migrateSettings({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.equal(settings.builder.host, 'cloudflare-pages')
  assert.equal(settings.builder.minIntervalMinutes, 5, 'the default it already had')
})

test('a hook URL that matches nothing is Another host, and nothing is rewritten', () => {
  const settings = migrateSettings({
    builder: { url: 'https://relay.example.com/build/abc', siteUrl: 'https://notes.example.com', minIntervalMinutes: 5 },
  })
  assert.equal(settings.builder.host, 'other')
  assert.equal(settings.builder.url, 'https://relay.example.com/build/abc')
  assert.equal(settings.builder.minIntervalMinutes, 5)
})

test('a vault with no hook yet opens on the recommended host', () => {
  assert.equal(migrateSettings({}).builder.host, 'cloudflare-pages')
  assert.equal(migrateSettings({ builder: { url: '   ' } }).builder.host, 'cloudflare-pages')
})

test('a stored host survives a round trip through an older build', () => {
  // An older build merges the builder with `Object.assign`, so a key it has
  // never heard of passes straight through. That is what makes the field safe
  // to add: a downgrade and an upgrade leave it where it was.
  const mine = migrateSettings({ builder: { url: PAGES_HOOK, host: 'vercel' } })
  assert.equal(mine.builder.host, 'vercel', 'an explicit choice outranks what the hook URL looks like')

  const throughOldBuild = JSON.parse(JSON.stringify(mine))
  assert.equal(migrateSettings(throughOldBuild).builder.host, 'vercel')
})

test('a vault that has never chosen opens on the recommended starter', () => {
  assert.equal(migrateSettings({}).builder.starter, 'jotter')
  assert.equal(migrateSettings({ builder: {} }).builder.starter, 'jotter')
})

test('a stored starter survives a round trip through an older build', () => {
  // The same property the host label has, and the reason this field could be
  // added without a version bump: an older build passes a key it has never
  // heard of straight through, so a downgrade and an upgrade leave it be.
  const mine = migrateSettings({ builder: { starter: 'jotter' } })
  assert.equal(mine.builder.starter, 'jotter')

  const throughOldBuild = JSON.parse(JSON.stringify(mine))
  assert.equal(migrateSettings(throughOldBuild).builder.starter, 'jotter')
})

test('a starter id from the future falls back rather than reaching a picker that cannot draw it', () => {
  assert.equal(migrateSettings({ builder: { starter: 'hugo' } }).builder.starter, 'jotter')
  assert.equal(migrateSettings({ builder: { starter: 42 } }).builder.starter, 'jotter')
})

test('a vault already on Quartz stays on Quartz when the recommendation moves', () => {
  // The default is only ever consulted for a value that is missing or
  // unrecognised, so moving it is not a migration of anybody's site.
  assert.equal(migrateSettings({ builder: { starter: 'quartz' } }).builder.starter, 'quartz')
})

test('a host id from the future is re-inferred rather than kept unrenderable', () => {
  const settings = migrateSettings({ builder: { url: NETLIFY_HOOK, host: 'fly' } })
  assert.equal(settings.builder.host, 'netlify')
  assert.equal(settings.builder.url, NETLIFY_HOOK, 'the hook URL is the source of truth either way')
})

test('migration stays idempotent with the host label in the file', () => {
  const once = migrateSettings({
    builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app', minIntervalMinutes: 30 },
    lastSnapshotId: 'snap-1',
  })
  assert.deepEqual(migrateSettings(JSON.parse(JSON.stringify(once))), once)
})

// --- where the last publish was served from ------------------------------

test('the host target notices a move and ignores everything that is not one', () => {
  const base = { host: 'netlify', siteUrl: 'https://x.netlify.app' }
  assert.notEqual(hostTarget(base), hostTarget({ ...base, host: 'vercel' }))
  assert.equal(hostTarget(base), hostTarget({ ...base, siteUrl: 'https://notes.example.com' }))
  assert.equal(hostTarget(base), hostTarget({ ...base, siteUrl: '' }))
})

test('putting a custom domain in front of the site is not a host move', () => {
  // The case that matters most, because this project's own setup guide tells
  // people to do exactly this and then update the address here. A panel telling
  // them to re-enter environment variables that are already correct is the
  // warning everyone learns to ignore before the real one arrives.
  const settings = migrateSettings({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    lastSnapshotId: 'snap-1',
  })
  settings.builder.siteUrl = 'https://notes.example.com'
  assert.equal(hasHostMoved(settings), false)
})

test('finishing setup after publishing is not a host move either', () => {
  const settings = migrateSettings({ builder: { url: PAGES_HOOK, siteUrl: '' }, lastSnapshotId: 'snap-1' })
  settings.builder.siteUrl = 'https://x.pages.dev'
  assert.equal(hasHostMoved(settings), false, 'the address was never what identified the host')
})

test('the deploy hook URL is not part of the target, because it is a credential', () => {
  // A second copy of it would sit unmasked in data.json and outlive the day
  // somebody rotates the first one.
  const settings = migrateSettings({
    builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(settings.lastPublishedHostTarget.includes('68a1f0c2d3e4b5a6c7d8e9f0'), false)
})

test('a vault that published before this field existed is credited with its own host', () => {
  const settings = migrateSettings({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(settings.lastPublishedHostTarget, hostTarget(settings.builder))
  assert.equal(hasHostMoved(settings), false, 'nothing has moved, so nothing is said')
})

test('publishing to one host and then pointing at another is called out', () => {
  const settings = migrateSettings({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    lastSnapshotId: 'snap-1',
  })
  settings.builder.url = NETLIFY_HOOK
  settings.builder.host = 'netlify'
  settings.builder.siteUrl = 'https://x.netlify.app'
  assert.equal(hasHostMoved(settings), true)
})

test('nothing is claimed before the first publish, or before the build settings are filled in', () => {
  const neverPublished = migrateSettings({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.equal(hasHostMoved(neverPublished), false)

  const halfTyped = migrateSettings({ lastSnapshotId: 'snap-1', lastPublishedHostTarget: 'netlify|https://old' })
  assert.equal(hasHostMoved(halfTyped), false, 'a half-typed hook is not a migration')
})

test('two devices infer the same host from the same file, so there is nothing to diverge', () => {
  const file = { builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } }
  const laptop = migrateSettings(JSON.parse(JSON.stringify(file)))
  const phone = migrateSettings(JSON.parse(JSON.stringify(file)))
  assert.deepEqual(laptop.builder, phone.builder)
})

// --- what a finished publish leaves behind -------------------------------

const published = (over = {}) =>
  migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    ...over,
  })

const outcome = (over = {}) => ({ snapshotId: 'snap-2', committed: true, buildTriggered: true, ...over })

test('a committed publish records where the content went and when', () => {
  const settings = published()
  recordPublish(settings, outcome(), 1_700_000_000_000)
  assert.equal(settings.lastSnapshotId, 'snap-2')
  assert.equal(settings.lastPublishedAt, 1_700_000_000_000)
  assert.equal(settings.lastPublishedTarget, storageTarget(settings.destination))
  assert.equal(settings.lastBuildTriggeredAt, 1_700_000_000_000)
  assert.equal(settings.lastPublishedHostTarget, hostTarget(settings.builder))
})

test('a publish that committed nothing records nothing at all', () => {
  // "Nothing has changed since the last publish" commits nothing and spends no
  // build, so it is not a publish to remember.
  const settings = published({ lastSnapshotId: 'snap-1' })
  const before = JSON.parse(JSON.stringify(settings))
  recordPublish(settings, outcome({ committed: false, buildTriggered: false }), 1_700_000_000_000)
  assert.deepEqual(settings, before)
})

test('a repair spends a build without committing, and the throttle is told', () => {
  // Putting back objects that went missing from storage rebuilds the snapshot
  // that is already live: no new content, but the host's allowance is a file
  // lighter. Forgetting that lets the very next publish walk past the minimum
  // interval as though no build had run.
  const settings = published({ lastSnapshotId: 'snap-1' })
  recordPublish(settings, outcome({ snapshotId: 'snap-1', committed: false }), 1_700_000_000_000)

  assert.equal(settings.lastBuildTriggeredAt, 1_700_000_000_000, 'the build really happened')
  assert.equal(settings.lastPublishedAt, null, 'but no new version of the site did')
  assert.equal(settings.lastSnapshotId, 'snap-1', 'and the live snapshot is the one it always was')
})

test('content published with no build leaves the old host on the record', () => {
  // The case the review caught. With automatic builds off, throttled, or
  // refused, the notes are in storage and the *old* host is still serving the
  // site. Recording the new one here cleared the "you have moved host" panel at
  // exactly the moment it was telling the truth.
  const settings = published({ lastSnapshotId: 'snap-1' })
  settings.lastPublishedHostTarget = 'netlify'
  recordPublish(settings, outcome({ buildTriggered: false }), 1_700_000_000_000)

  assert.equal(settings.lastSnapshotId, 'snap-2', 'the content really did move')
  assert.equal(settings.lastPublishedTarget, storageTarget(settings.destination))
  assert.equal(settings.lastPublishedHostTarget, 'netlify', 'but nothing built here yet')
  assert.equal(settings.lastBuildTriggeredAt, null, 'and no build was spent')
  assert.equal(hasHostMoved(settings), true, 'so the warning still stands')
})

test('the build that follows it does clear the warning', () => {
  const settings = published({ lastSnapshotId: 'snap-1' })
  settings.lastPublishedHostTarget = 'netlify'
  recordPublish(settings, outcome({ buildTriggered: false }), 1_700_000_000_000)
  recordPublish(settings, outcome({ snapshotId: 'snap-3' }), 1_700_000_060_000)
  assert.equal(hasHostMoved(settings), false)
  assert.equal(settings.lastPublishedHostTarget, 'cloudflare-pages')
})

// --- the gateway ---------------------------------------------------------

test('a vault configured for direct S3 loads exactly as it did before the gateway existed', () => {
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
  })
  assert.equal(settings.destination.type, 's3')
  assert.equal(settings.destination.provider, 'r2')
  assert.equal(settings.destination.accessKeyId, 'k')
  assert.equal(settings.destination.workerUrl, undefined, 'nothing from the other shape leaks in')
  assert.equal(settings.destination.tokenRef, undefined)
})

test('a key stored inline by an older build is dropped, not carried forward', () => {
  // The one migration that has to *lose* something. This plugin has never
  // shipped, so there is no vault in the world holding one of these, but the
  // S3 branch merges whatever `data.json` had and the next `saveSettings()`
  // writes the merged object straight back. Without this, a key that reached
  // `data.json` by any route at all would live there for good, which is the
  // single thing this whole change exists to prevent.
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 'shh' },
  })
  assert.equal(settings.destination.secretAccessKey, undefined)
  assert.equal(settings.destination.secretRef, '', 'and it is not mistaken for the name of one either')
  assert.doesNotMatch(JSON.stringify(settings), /shh/, 'nothing that gets written back holds it')
})

test('a stored gateway loads as one, and names a token instead of holding keys', () => {
  const settings = migrateSettings({
    destination: {
      type: 'gateway',
      provider: 'gateway',
      workerUrl: 'https://gw.someone.workers.dev',
      tokenRef: 'op-gateway-token',
      prefix: '/sites/notes/',
    },
  })
  assert.equal(settings.destination.type, 'gateway')
  assert.equal(settings.destination.provider, 'gateway')
  assert.equal(settings.destination.workerUrl, 'https://gw.someone.workers.dev')
  assert.equal(settings.destination.tokenRef, 'op-gateway-token')
  assert.equal(settings.destination.prefix, 'sites/notes')
  assert.equal(settings.destination.accessKeyId, undefined, 'a gateway has no keys to carry')
})

test('a gateway with nothing usable in it is empty rather than half-typed', () => {
  const settings = migrateSettings({ destination: { type: 'gateway', workerUrl: 42, tokenRef: null } })
  assert.deepEqual(settings.destination, {
    type: 'gateway',
    provider: 'gateway',
    workerUrl: '',
    tokenRef: '',
    prefix: '',
  })
  assert.equal(isDestinationConfigured(settings), false)
})

test('a gateway is ready on an address and a named token, and not before', () => {
  const half = migrateSettings({ destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev' } })
  assert.equal(isDestinationConfigured(half), false, 'an address with no token reaches nothing')

  half.destination.tokenRef = 'op-gateway-token'
  assert.equal(isDestinationConfigured(half), true)
})

test('a gateway label on an S3 destination is re-inferred, not honoured', () => {
  // Half of a switch, arriving from a crash or a hand-edit. Honouring it would
  // render a Worker form over a bucket's credentials.
  const settings = migrateSettings({
    destination: { provider: 'gateway', endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' },
  })
  assert.equal(settings.destination.type, 's3')
  assert.equal(settings.destination.provider, 'r2')
})

test('putting a gateway in front of the bucket you already publish to counts as a move', () => {
  // The content has not gone anywhere. The route the build must be told about
  // has, and the read-only keys in the host's environment are still the old
  // ones, so this is exactly the case the warning exists for.
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(hasStorageMoved(settings), false)

  settings.destination = { type: 'gateway', provider: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' }
  assert.equal(hasStorageMoved(settings), true)
})

test('two gateways are told apart by address and prefix, and by nothing else', () => {
  const gateway = (extra) => ({ type: 'gateway', provider: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token', ...extra })
  assert.equal(
    storageTarget(gateway()),
    storageTarget(gateway({ tokenRef: 'op-gateway-token-2' })),
    'renaming the keychain entry has not moved the storage, and must not raise the panel that says it has',
  )
  assert.notEqual(storageTarget(gateway()), storageTarget(gateway({ prefix: 'notes' })))
  assert.notEqual(storageTarget(gateway()), storageTarget(gateway({ workerUrl: 'https://other.workers.dev' })))
  assert.doesNotMatch(storageTarget(gateway()), /op-gateway-token/, 'nothing about the credential goes in a signature')
})

test('a gateway move is hedged, because the plugin cannot see which bucket it reaches', () => {
  // The path the gateway's own README recommends is pointing a Worker at the
  // bucket you already publish to. The plain warning asserts the opposite of
  // what happens there: it promises a full re-upload and a site building from
  // the old storage, when content is addressed by hash and the bucket has not
  // changed. A gateway holds no bucket name, so the honest version says "if".
  const settings = migrateSettings({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  assert.match(storageMovedWarning(settings), /uploads everything again/)

  settings.destination = { type: 'gateway', provider: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' }
  const hedged = storageMovedWarning(settings)
  assert.equal(hasStorageMoved(settings), true, 'the route changed, so a panel is still right')
  assert.match(hedged, /If it reaches the same bucket, nothing is lost/)
  assert.match(hedged, /OP_PREFIX/, 'the one value that actually has to change')
  assert.doesNotMatch(hedged, /uploads everything again/)
})

test('and the same hedge applies coming back off a gateway', () => {
  const settings = migrateSettings({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
    lastSnapshotId: 'snap-1',
  })
  settings.destination = { type: 's3', provider: 'r2', endpoint: R2_ENDPOINT, bucket: 'my-notes', region: 'auto', accessKeyId: 'k', secretRef: 'op-r2-secret', prefix: '', forcePathStyle: true }
  assert.match(storageMovedWarning(settings), /If it reaches the same bucket/)
})

// --- the rollback in force ------------------------------------------------

test('a data.json written before rollback existed loads with none in force', () => {
  const settings = migrateSettings({ lastSnapshotId: 'snap-1' })
  assert.equal(settings.lastRollback, null)
  assert.equal(isRolledBack(settings), false)
  assert.equal(rollbackWarning(settings), null)
})

test('a stored rollback survives the round trip', () => {
  const settings = migrateSettings({
    lastRollback: { to: '2026-08-14T09-12-00Z-aaaaaa', from: '2026-08-20T11-30-00Z-bbbbbb', at: 1_700_000_000_000 },
  })
  assert.deepEqual(settings.lastRollback, {
    to: '2026-08-14T09-12-00Z-aaaaaa',
    from: '2026-08-20T11-30-00Z-bbbbbb',
    at: 1_700_000_000_000,
  })
  assert.equal(isRolledBack(settings), true)
})

test('a half-shaped rollback is dropped rather than trusted', () => {
  // Validated field by field like `site.analytics`, because this one decides
  // whether a panel claims the site is behind the notes.
  for (const stored of [{}, { from: 'x' }, { to: 42 }, { to: '' }, 'nonsense', []]) {
    assert.equal(migrateSettings({ lastRollback: stored }).lastRollback, null, JSON.stringify(stored))
  }
  const partial = migrateSettings({ lastRollback: { to: 'snap-1' } })
  assert.deepEqual(partial.lastRollback, { to: 'snap-1', from: null, at: 0 })
})

test('the warning names the version, read out of its own ID', () => {
  const settings = migrateSettings({ lastRollback: { to: '2026-08-14T09-12-00Z-aaaaaa', from: null, at: 1 } })
  const warning = rollbackWarning(settings)
  assert.ok(warning.includes(new Date(Date.UTC(2026, 7, 14, 9, 12)).toLocaleString()))
  assert.match(warning, /Publishing takes the site forward/)
})

test('an ID that carries no timestamp falls back to when the pointer moved', () => {
  const settings = migrateSettings({ lastRollback: { to: 'snap-1', from: null, at: 1_700_000_000_000 } })
  assert.ok(rollbackWarning(settings).includes(new Date(1_700_000_000_000).toLocaleString()))
})

test('publishing forward is what clears it', () => {
  // A state, not an event: it stands until somebody publishes past it, which is
  // the step every real rollback ends with.
  const settings = published({ lastRollback: { to: 'snap-old', from: 'snap-new', at: 1 } })
  assert.equal(isRolledBack(settings), true)

  recordPublish(settings, outcome(), 1_700_000_000_000)
  assert.equal(settings.lastRollback, null)
  assert.equal(isRolledBack(settings), false)
})

test('a publish that committed nothing leaves the rollback standing', () => {
  // Nothing changed, so the site is still showing the older version and the
  // panel is still telling the truth.
  const settings = published({ lastRollback: { to: 'snap-old', from: 'snap-new', at: 1 } })
  recordPublish(settings, outcome({ committed: false }), 1_700_000_000_000)
  assert.equal(isRolledBack(settings), true)
})

test('the language defaults to en-US, round-trips, and refuses anything else', () => {
  assert.equal(migrateSettings({}).site.locale, 'en-US')
  assert.equal(migrateSettings({ site: { locale: 'fa-IR' } }).site.locale, 'fa-IR')
  for (const junk of ['klingon', 'fa', '', null, 42, { locale: 'fa-IR' }]) {
    const settings = migrateSettings({ site: { locale: junk } })
    assert.equal(settings.site.locale, 'en-US', `${JSON.stringify(junk)} fell back`)
    assert.equal(settings.site.dir, 'ltr', 'and took the direction of the language it fell back to')
  }
})

test('direction is re-derived on every load, so a stale data.json cannot disagree with itself', () => {
  // The whole reason `dir` has no control of its own. Hand-edit it, sync a
  // half-written file between devices, downgrade and upgrade again: the
  // language is the only thing that decides, and it decides again here.
  assert.equal(migrateSettings({ site: { locale: 'fa-IR', dir: 'ltr' } }).site.dir, 'rtl')
  assert.equal(migrateSettings({ site: { locale: 'en-US', dir: 'rtl' } }).site.dir, 'ltr')
  assert.equal(migrateSettings({ site: { locale: 'ar-SA', dir: 'sideways' } }).site.dir, 'rtl')
  assert.equal(migrateSettings({ site: { dir: 'sideways' } }).site.dir, 'ltr', 'no language at all')
})

test('the URL style defaults to clean, round-trips, and refuses anything else', () => {
  assert.equal(migrateSettings({}).urlStyle, 'clean', 'nobody gets redirect pages they did not ask for')
  assert.equal(migrateSettings({ urlStyle: 'clean-with-redirects' }).urlStyle, 'clean-with-redirects')
  for (const junk of ['obsidian', '', null, 42, { style: 'clean' }]) {
    assert.equal(migrateSettings({ urlStyle: junk }).urlStyle, 'clean', `${JSON.stringify(junk)} fell back`)
  }
})
