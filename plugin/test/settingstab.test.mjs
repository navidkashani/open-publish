/**
 * The settings tab, rendered.
 *
 * It went untested for a long time for a dull reason: two calls in it
 * (`settingEl.toggle`, `insertAdjacentElement`) had no stand-in in the test
 * DOM, so `display()` threw before it drew anything. Those exist now, and this
 * is the first thing that would notice a third one appearing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenPublishSettingTab, fakeApp, fakeStoragePlugin, secretFields } from './harness.mjs'
import { byClass, click, dispatch, find, findAll, visible } from './dom.mjs'

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'

function open(stored = {}, appOptions = {}) {
  const app = fakeApp({ files: ['Notes/Home.md'], folders: ['Notes'], ...appOptions })
  const plugin = fakeStoragePlugin({ stored })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.display()
  return { tab, plugin, root: tab.containerEl }
}

const rowNamed = (root, name) =>
  find(root, (node) => node.hasClass('setting-item') && find(node, byClass('setting-item-name'))?.textContent === name)

const inputIn = (row) => find(row, (node) => node.tagName === 'INPUT' || node.tagName === 'SELECT')
const descOf = (row) => find(row, byClass('setting-item-description'))?.textContent ?? ''
const errorOf = (row) => find(row, byClass('setting-item-error'))?.textContent ?? null

/**
 * The keychain field inside a row, found by where it was drawn.
 *
 * `SecretComponent` is built by the caller rather than by the row, so unlike
 * every other component here there is no `addX` call to intercept. The stub
 * records each one it constructs; this picks the one whose element sits inside
 * the row asked for.
 */
const secretIn = (row) =>
  secretFields.findLast((field) => {
    for (let node = field.containerEl; node; node = node.parentElement) if (node === row) return true
    return false
  }) ?? null

test('display() renders every section without throwing', () => {
  const { root } = open()
  for (const heading of ['Storage', 'Site build', 'What gets published', 'Site options', 'Maintenance']) {
    assert.ok(
      find(root, (node) => node.hasClass('setting-item-heading') && node.textContent.startsWith(heading)),
      `missing heading: ${heading}`,
    )
  }
})

test('the analytics ID field hides itself when no provider is chosen', () => {
  const { root } = open()
  const id = rowNamed(root, 'Tracking ID')
  assert.equal(visible(id), false, 'nothing to type an ID into until a provider is picked')

  const { root: withProvider } = open({ site: { analytics: { provider: 'plausible', id: 'notes.example.com' } } })
  const shown = rowNamed(withProvider, 'Tracking ID')
  assert.equal(visible(shown), true)
  assert.match(descOf(shown), /Plausible domain/)
})

test('the analytics provider dropdown is rendered above the field it governs', () => {
  const { root } = open()
  const rows = findAll(root, (node) => node.hasClass('setting-item'))
  const provider = rows.indexOf(rowNamed(root, 'Provider'))
  const id = rows.indexOf(rowNamed(root, 'Tracking ID'))
  assert.ok(provider >= 0 && id >= 0)
  assert.ok(id < provider, 'the insertAdjacentElement move puts the ID row first in the DOM')
})

// --- the storage picker -------------------------------------------------

test('a fresh vault starts on the recommended provider and asks for one value', () => {
  const { root } = open()
  const provider = rowNamed(root, 'Storage provider')
  assert.equal(inputIn(provider).value, 'r2')
  assert.ok(rowNamed(root, 'Account ID'), 'R2 asks for an account ID, not an endpoint')
  assert.equal(visible(rowNamed(root, 'Endpoint')), false, 'the raw endpoint lives in Advanced')
})

test('an existing R2 endpoint is recognised, and the account ID is read back out of it', () => {
  const { root } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  assert.equal(inputIn(rowNamed(root, 'Storage provider')).value, 'r2')
  assert.equal(inputIn(rowNamed(root, 'Account ID')).value, '0123456789abcdef0123456789abcdef')
  assert.match(root.textContent, /Your endpoint: https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com/)
})

test('an endpoint that matches no template is left alone as Other', () => {
  const { root } = open({ destination: { endpoint: 'https://files.example.com', bucket: 'b' } })
  assert.equal(inputIn(rowNamed(root, 'Storage provider')).value, 'other')
  assert.equal(inputIn(rowNamed(root, 'Endpoint')).value, 'https://files.example.com')
})

test('Advanced starts closed when every field inside holds the provider default', () => {
  const { root } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'false')
  assert.equal(toggle.textContent, 'Advanced')
  assert.equal(visible(rowNamed(root, 'Key prefix')), false)
})

test('Advanced starts open when a key prefix is set, and says so on the label', () => {
  const { root } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.equal(toggle.textContent, 'Advanced · key prefix "notes"')
  assert.equal(visible(rowNamed(root, 'Key prefix')), true, 'nothing the user chose is ever hidden')
})

test('two non-default advanced fields are counted rather than listed', () => {
  const { root } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes', forcePathStyle: false },
  })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.textContent, 'Advanced · 2 fields changed')
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
})

test('Advanced opens and closes on click', () => {
  const { root } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  click(toggle)
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.equal(visible(rowNamed(root, 'Key prefix')), true)
  click(toggle)
  assert.equal(toggle.getAttr('aria-expanded'), 'false')
})

test('switching provider keeps the bucket and the credentials', () => {
  const { root, plugin } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretRef: 'op-r2-secret' },
  })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'aws'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.bucket, 'my-notes')
  assert.equal(plugin.settings.destination.accessKeyId, 'AKIA')
  assert.equal(plugin.settings.destination.secretRef, 'op-r2-secret')
  assert.equal(plugin.settings.destination.provider, 'aws')
  assert.equal(plugin.settings.destination.endpoint, '', 'an account ID is not a region, so it is not carried over')
})

test('choosing the gateway swaps the form: one address and one token, no bucket and no keys', () => {
  const { root, plugin } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretRef: 'op-r2-secret' },
  })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'gateway'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.type, 'gateway')
  assert.equal(plugin.settings.destination.accessKeyId, undefined, 'a key nothing uses is pure added risk')
  assert.equal(plugin.settings.destination.secretRef, undefined)

  const after = plugin.settings.destination
  const { root: gateway } = open({ destination: after })
  assert.ok(rowNamed(gateway, 'Worker address'))
  assert.ok(rowNamed(gateway, 'Token'))
  assert.equal(rowNamed(gateway, 'Bucket'), null)
  assert.equal(rowNamed(gateway, 'Access key ID'), null)
  assert.equal(rowNamed(gateway, 'Region'), null, 'nothing here is signed, so there is no region to sign it for')
})

test('the token row holds a keychain name, and never the token', () => {
  // What this replaced asserted that the field was `type="password"`, which hid
  // the token from a person looking over your shoulder and from nothing else:
  // the value was still in `data.json` and still written into the DOM on every
  // render. There is no text input here at all now.
  const { root } = open(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const row = rowNamed(root, 'Token')
  assert.equal(inputIn(row), null, 'nothing on this row takes typing')
  assert.equal(secretIn(row).settingKey, 'op-gateway-token', 'the component is pointed at the stored name')
  assert.match(descOf(row), /op-gateway-token/, 'and the name is legible without opening the picker')
  assert.doesNotMatch(root.textContent, /shh/, 'the token itself is never drawn')
})

test('linking a secret stores its name, and unlinking clears the name alone', () => {
  const { root, plugin } = open(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const secret = secretIn(rowNamed(root, 'Token'))

  secret.link('op-gateway-token')
  assert.equal(plugin.settings.destination.tokenRef, 'op-gateway-token')

  // The real component passes null here, though its published type says string.
  secret.unlink()
  assert.equal(plugin.settings.destination.tokenRef, '', 'null is not a name')
})

test('a name this device cannot resolve is said out loud, and never quietly cleared', () => {
  // The ordinary state of every device after the first: `data.json` syncs and
  // the keychain does not. Obsidian's own component draws this exactly as it
  // draws a name that was never set, so if the row said nothing the obvious
  // move would be to link a *new* name, overwrite the one in `data.json`, sync
  // it back, and take down the device that was working.
  const { root, plugin } = open({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  })
  const row = rowNamed(root, 'Token')
  assert.match(errorOf(row) ?? '', /this device does not have it/)
  assert.match(errorOf(row), /op-gateway-token/, 'named, so it can be recognised or recreated')
  assert.equal(plugin.settings.destination.tokenRef, 'op-gateway-token', 'and the name survives being unresolvable')
})

test('switching away from the gateway drops the token reference, and leaves the keychain alone', () => {
  const { root, plugin, tab } = open(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'r2'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.type, 's3')
  assert.equal(plugin.settings.destination.tokenRef, undefined)
  // Deliberate, and the half that changed. What is discarded is the reference;
  // the keychain is shared with every other plugin and is not this one's to
  // empty, and switching provider is something people switch back from.
  assert.equal(tab.app.secretStorage.getSecret('op-gateway-token'), 'shh')
  assert.equal(plugin.settings.destination.workerUrl, undefined)
  assert.equal(plugin.settings.destination.bucket, '', 'and it starts from a fresh S3 form, not a half-filled one')
})

test('a gateway keeps the one Advanced row it has a use for', () => {
  const { root } = open({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token', prefix: 'notes' },
  })
  assert.match(find(root, byClass('op-advanced-toggle')).textContent, /key prefix "notes"/)
  assert.ok(rowNamed(root, 'Key prefix'))
  assert.equal(rowNamed(root, 'Path-style addressing'), null)
})

test('a key prefix that would silently address somewhere else is refused where it is typed', () => {
  // `a/../b` is not an invalid path, it is a valid path to somewhere else: the
  // URL parser removes the dot segment before any request is built, so this
  // cannot be caught downstream. The gateway Worker rejects ".." only on the
  // listing route, where the prefix survives in a query string.
  for (const destination of [
    { endpoint: R2_ENDPOINT, bucket: 'b' },
    { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  ]) {
    const { root } = open({ destination })
    const row = rowNamed(root, 'Key prefix')
    const field = inputIn(row)

    field.value = 'notes/../elsewhere'
    dispatch(field, 'blur')
    assert.match(errorOf(row) ?? '', /cannot contain/, `${destination.type ?? 's3'}: accepted a traversing prefix`)

    field.value = 'notes/blog'
    dispatch(field, 'blur')
    assert.equal(errorOf(row), null, 'an ordinary prefix is still ordinary')
  }
})

test('the credentials note is about whatever is actually stored', () => {
  const { root: keys } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'b' } })
  const keyNote = find(keys, byClass('op-security-note')).textContent
  assert.match(keyNote, /these keys/i)
  assert.match(keyNote, /do not travel with your notes/, 'the half of the old sentence this change made false')

  const { root: token } = open({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  })
  const note = find(token, byClass('op-security-note')).textContent
  assert.match(note, /this token/i)
  assert.match(note, /not encryption/, 'the one claim this must never make')
  // The claim that survived the move, and the one people care about. Obsidian's
  // keychain is one namespace on the same `app` object every plugin is handed.
  assert.match(note, /Any other plugin you install can still read it/)
})

test('switching to Other keeps the endpoint, because nothing about it is a template', () => {
  const { root, plugin } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'other'
  dispatch(dropdown, 'input')
  assert.equal(plugin.settings.destination.endpoint, R2_ENDPOINT)
})

test('the composed endpoint updates as the account ID is typed', () => {
  const { root, plugin } = open()
  const field = inputIn(rowNamed(root, 'Account ID'))
  field.value = 'abcdef01234567890abcdef012345678'
  dispatch(field, 'input')

  assert.equal(plugin.settings.destination.endpoint, 'https://abcdef01234567890abcdef012345678.r2.cloudflarestorage.com')
  assert.match(root.textContent, /Your endpoint: https:\/\/abcdef01234567890abcdef012345678\.r2\.cloudflarestorage\.com/)
})

test('the blank and the endpoint behind Advanced stay in step, in both directions', () => {
  // Otherwise: type an account ID with Advanced open, touch the endpoint field,
  // and the stale value it was still showing gets written back over the new one.
  const { root, plugin } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes' } })
  const account = inputIn(rowNamed(root, 'Account ID'))
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  assert.equal(endpoint.value, R2_ENDPOINT)

  account.value = 'ffffffffffffffffffffffffffffffff'
  dispatch(account, 'input')
  assert.equal(endpoint.value, 'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com')

  endpoint.value = 'https://notes.example.com'
  dispatch(endpoint, 'input')
  assert.equal(plugin.settings.destination.endpoint, 'https://notes.example.com')
  assert.equal(account.value, '', 'the endpoint no longer derives from an account ID, and says so')
  assert.match(root.textContent, /Your endpoint: https:\/\/notes\.example\.com/)
  assert.match(find(root, byClass('op-advanced-toggle')).textContent, /2 fields changed/)
})

test('a malformed account ID is reported on blur, never mid-typing', () => {
  const { root } = open()
  const row = rowNamed(root, 'Account ID')
  const field = inputIn(row)

  field.value = 'abc'
  dispatch(field, 'input')
  assert.equal(errorOf(row), null, 'the first three characters of a 32-character ID are not an error')

  dispatch(field, 'blur')
  assert.match(errorOf(row), /32 letters and numbers/)

  field.value = '0123456789abcdef0123456789abcdef'
  dispatch(field, 'input')
  dispatch(field, 'blur')
  assert.equal(errorOf(row), null)
})

test('an address without a scheme is reported, on the providers that take one', () => {
  const { root } = open({ destination: { provider: 'minio', endpoint: '' } })
  const row = rowNamed(root, 'Server address')
  const field = inputIn(row)
  field.value = 'localhost:9000'
  dispatch(field, 'input')
  dispatch(field, 'blur')
  assert.match(errorOf(row), /https:\/\/ or http:\/\//)
})

test('Wasabi carries its deletion cost wherever it is chosen', () => {
  const { root } = open({ destination: { provider: 'wasabi', endpoint: 'https://s3.eu-central-1.wasabisys.com' } })
  assert.match(root.textContent, /90 days/)
})

test('the two-device row states the expectation, then the measured truth', async () => {
  const app = fakeApp({ files: [], folders: [] })
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
    testResult: { ok: true, conditionalWrites: 'ignored' },
  })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.display()

  const row = rowNamed(tab.containerEl, 'Publishing from two devices')
  assert.match(descOf(row), /Safe\./)

  const button = find(rowNamed(tab.containerEl, 'Test connection'), (node) => node.tagName === 'BUTTON')
  click(button)
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(descOf(rowNamed(tab.containerEl, 'Publishing from two devices')), /could overwrite each other/)
})

test('a storage target that no longer matches the published one says so', () => {
  const { root } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'new-bucket', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
    lastPublishedTarget: `${R2_ENDPOINT}|old-bucket||path`,
  })
  const warning = find(root, byClass('op-storage-moved'))
  assert.ok(warning, 'switching storage after publishing is a migration, and has to be said out loud')
  assert.match(warning.textContent, /uploads everything again/)
  assert.match(warning.textContent, /keeps building from the old storage/)
})

test('no such warning when the target is the one that was published to', () => {
  const { root } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(find(root, byClass('op-storage-moved')), null)
})

test('the deletion charge is repeated where the money is actually spent', () => {
  const { root } = open({ destination: { provider: 'wasabi', endpoint: 'https://s3.eu-central-1.wasabisys.com' } })
  assert.match(descOf(rowNamed(root, 'Clean up unused files')), /90 days/)

  const { root: onR2 } = open({ destination: { endpoint: R2_ENDPOINT } })
  assert.doesNotMatch(descOf(rowNamed(onR2, 'Clean up unused files')), /90 days/)
})

// --- what a review caught -------------------------------------------------

test('editing the endpoint moves the signing region with it, on the providers where they are the same thing', () => {
  // Otherwise every request is signed for the old region, S3 answers
  // SignatureDoesNotMatch, and the user is told their credentials were
  // rejected and goes off to regenerate keys that were never the problem.
  const { root, plugin } = open({
    destination: {
      provider: 'aws',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      bucket: 'b',
      forcePathStyle: false,
    },
  })
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  endpoint.value = 'https://s3.us-east-1.amazonaws.com'
  dispatch(endpoint, 'input')

  assert.equal(plugin.settings.destination.region, 'us-east-1')
  assert.equal(inputIn(rowNamed(root, 'Region')).value, 'us-east-1', 'and the field says so')
})

test('an endpoint with no region in it leaves one editable by hand', () => {
  const { root, plugin } = open({
    destination: {
      provider: 'aws',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      bucket: 'b',
      forcePathStyle: false,
    },
  })
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  endpoint.value = 'https://s3.internal.example.com'
  dispatch(endpoint, 'input')

  assert.equal(plugin.settings.destination.region, 'eu-west-1', 'the last known region stands')
  const region = inputIn(rowNamed(root, 'Region'))
  assert.ok(region, 'and there is somewhere to correct it')
  region.value = 'us-east-2'
  dispatch(region, 'input')
  assert.equal(plugin.settings.destination.region, 'us-east-2')
})

test('a region that disagrees with the endpoint is surfaced rather than left silent', () => {
  const { root } = open({
    destination: { provider: 'aws', endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'us-east-1', forcePathStyle: false },
  })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.match(toggle.textContent, /region "us-east-1"/)
})

test('editing storage retires the last measurement rather than letting it go stale', async () => {
  const app = fakeApp({ files: [], folders: [] })
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
    testResult: { ok: true, conditionalWrites: 'enforced' },
  })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.display()
  const root = tab.containerEl

  click(find(rowNamed(root, 'Test connection'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(descOf(rowNamed(root, 'Publishing from two devices')), /Safe\./)

  const bucket = inputIn(rowNamed(root, 'Bucket'))
  bucket.value = 'somewhere-else'
  dispatch(bucket, 'input')
  assert.match(
    descOf(rowNamed(root, 'Publishing from two devices')),
    /Safe\./,
    'R2 still expects safety, but it is now an expectation again',
  )
})

test('switching provider mid-test drops the answer instead of pinning it to the new one', async () => {
  const app = fakeApp({ files: [], folders: [] })
  let release
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
  })
  plugin.testDestination = () => new Promise((resolve) => { release = () => resolve({ ok: true, conditionalWrites: 'enforced' }) })

  const tab = new OpenPublishSettingTab(app, plugin)
  tab.display()
  click(find(rowNamed(tab.containerEl, 'Test connection'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  const dropdown = inputIn(rowNamed(tab.containerEl, 'Storage provider'))
  dropdown.value = 'b2'
  dispatch(dropdown, 'input')
  release()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.settings.destination.provider, 'b2')
  assert.match(
    descOf(rowNamed(tab.containerEl, 'Publishing from two devices')),
    /check two-device safety when you connect/,
    "R2's result says nothing about B2",
  )
})

test('changing provider updates the copy outside the storage form too', () => {
  const { root, plugin } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'b' } })
  assert.doesNotMatch(descOf(rowNamed(root, 'Clean up unused files')), /90 days/)

  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'wasabi'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.provider, 'wasabi')
  assert.match(descOf(rowNamed(root, 'Clean up unused files')), /90 days/)
})

// --- the site build section ----------------------------------------------

const NETLIFY_HOOK = 'https://api.netlify.com/build_hooks/68a1f0c2d3e4b5a6c7d8e9f0'
const PAGES_HOOK = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/0f7a1c2e3b4d5e6f'

const buildSection = (root) => find(root, byClass('op-build-fields'))

test('a fresh vault starts on the recommended host and asks for a hook URL', () => {
  const { root } = open()
  const host = rowNamed(root, 'Hosting provider')
  assert.equal(inputIn(host).value, 'cloudflare-pages')
  assert.ok(rowNamed(root, 'Deploy hook URL'))
  assert.ok(rowNamed(root, 'Site URL'))
  assert.equal(visible(rowNamed(root, 'Build logs URL')), false, 'the optional one lives in Advanced')
})

test('the free plan quoted is the one the user is actually on', () => {
  // The bug this replaced: every user, on every host, was told "Cloudflare
  // Pages' free plan allows 500 builds a month", which on Netlify is wrong by
  // more than an order of magnitude in the direction that costs them the month.
  const { root } = open({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.match(descOf(rowNamed(root, 'Minimum minutes between builds')), /500 builds a month/)

  const { root: onNetlify } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  const desc = descOf(rowNamed(onNetlify, 'Minimum minutes between builds'))
  assert.match(desc, /about 20 site updates a month/)
  assert.doesNotMatch(desc, /Cloudflare|500 builds/)
})

test('only the host whose month can run out gets a standing panel', () => {
  const { root } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  const panel = find(root, byClass('op-build-allowance'))
  assert.ok(panel, 'a 20-deploy month is worth a panel next to the switch that spends it')
  assert.match(panel.textContent, /Build after publishing/)

  const { root: onPages } = open({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.equal(find(onPages, byClass('op-build-allowance')), null, 'undifferentiated warnings train dismissal')
})

test('the two controls that govern the bill stay out of Advanced', () => {
  const { root } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  assert.equal(visible(rowNamed(root, 'Build after publishing')), true)
  assert.equal(visible(rowNamed(root, 'Minimum minutes between builds')), true)
})

test('an existing hook URL is recognised, and the label says where it came from', () => {
  const { root } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'netlify')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /Recognised from your deploy hook/)
})

test('a hook URL that matches nothing claims nothing', () => {
  const { root } = open({ builder: { url: 'https://relay.example.com/build/x', siteUrl: 'https://notes.example.com' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'other')
  assert.doesNotMatch(descOf(rowNamed(root, 'Hosting provider')), /Recognised from/)
})

test('pasting a hook URL relabels the host without disturbing what was typed', () => {
  const { root, plugin } = open({ builder: { siteUrl: 'https://x.netlify.app', minIntervalMinutes: 17 } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = NETLIFY_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'netlify')
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'netlify', 'and the control says so')
  assert.equal(plugin.settings.builder.siteUrl, 'https://x.netlify.app')
  assert.equal(plugin.settings.builder.minIntervalMinutes, 17, 'a number that governs a bill is never inferred')
})

test("relabelling brings the new host's caveat with it, rather than dropping it", () => {
  // setDesc replaces the description element's contents, so anything under it
  // has to be rebuilt. Getting this wrong silently lost the one line saying
  // that renames will not redirect on Vercel.
  const { root } = open()
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = 'https://api.vercel.com/v1/integrations/deploy/prj_a/b1'
  dispatch(hook, 'input')

  const desc = descOf(rowNamed(root, 'Hosting provider'))
  assert.match(desc, /100 deploys a day/)
  assert.match(desc, /vercel\.json/)
  assert.match(desc, /Recognised from your deploy hook/)
})

test('switching host by hand keeps the hook URL and the site URL', () => {
  const { root, plugin } = open({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  const dropdown = inputIn(rowNamed(root, 'Hosting provider'))
  dropdown.value = 'vercel'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.builder.host, 'vercel')
  assert.equal(plugin.settings.builder.url, PAGES_HOOK, 'a deploy hook URL can only be pasted, never derived')
  assert.equal(plugin.settings.builder.siteUrl, 'https://x.pages.dev')
})

test('an explicit pick that disagrees with the hook URL is stated once, not argued with', () => {
  const { root } = open({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'vercel', 'the deliberate choice stands')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /looks like a Netlify one/)
})

test('a host that cannot report its own address says so where the address is typed', () => {
  const { root } = open({ builder: { host: 'cloudflare-workers', url: '', siteUrl: '' } })
  assert.match(descOf(rowNamed(root, 'Site URL')), /OP_SITE_URL/)

  const { root: onPages } = open({ builder: { url: PAGES_HOOK } })
  assert.doesNotMatch(descOf(rowNamed(onPages, 'Site URL')), /OP_SITE_URL/)
})

test('a deliberate pick survives the hook URL being edited again', () => {
  // Inference applies itself on new evidence, not on every keystroke. Re-typing
  // a URL that says what it already said is not new evidence, and overruling a
  // deliberate choice with it made the "looks like a Netlify one" line
  // unreachable through the very form that shows it.
  const { root, plugin } = open({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))

  hook.value = ''
  dispatch(hook, 'input')
  hook.value = NETLIFY_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'vercel', 'the deliberate choice stands')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /looks like a Netlify one/)
})

test('a genuinely different hook URL does overrule the earlier pick', () => {
  const { root, plugin } = open({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = PAGES_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'cloudflare-pages', 'a new host is new evidence')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /Recognised from your deploy hook/)
})

test('the escape-hatch host asks for a site address the build can read', () => {
  const { root } = open({ builder: { url: 'https://relay.example.com/build/x', siteUrl: 'https://notes.example.com' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'other')
  assert.match(descOf(rowNamed(root, 'Site URL')), /OP_SITE_URL/)
})

test("Vercel's missing redirects are a line, not an alarm", () => {
  const { root } = open({ builder: { host: 'vercel', url: 'https://api.vercel.com/v1/integrations/deploy/prj_a/b1' } })
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /vercel\.json/)
  assert.equal(find(buildSection(root), byClass('op-build-allowance')), null)
})

test('Advanced holds the build logs URL, and opens by itself when one is set', () => {
  const { root } = open({ builder: { url: PAGES_HOOK } })
  const closed = find(buildSection(root), byClass('op-advanced-toggle'))
  assert.equal(closed.getAttr('aria-expanded'), 'false')
  assert.equal(closed.textContent, 'Advanced')

  const { root: withLogs } = open({ builder: { url: PAGES_HOOK, logsUrl: 'https://dash.example/logs' } })
  const open2 = find(buildSection(withLogs), byClass('op-advanced-toggle'))
  assert.equal(open2.getAttr('aria-expanded'), 'true')
  assert.equal(open2.textContent, 'Advanced · build logs URL')
  assert.equal(visible(rowNamed(withLogs, 'Build logs URL')), true)
})

test('the request method is reachable, and says so when it is not the default', () => {
  // It was stored, read by the builder, and settable from nowhere, so only POST
  // could ever be sent. A hook behind a relay is the case that needs it.
  const { root, plugin } = open({ builder: { url: PAGES_HOOK } })
  const toggle = find(buildSection(root), byClass('op-advanced-toggle'))
  click(toggle)
  const method = inputIn(rowNamed(root, 'Request method'))
  assert.equal(method.value, 'POST')

  method.value = 'GET'
  dispatch(method, 'input')
  assert.equal(plugin.settings.builder.method, 'GET')
  assert.equal(toggle.textContent, 'Advanced · GET request')

  const { root: reopened } = open({ builder: { url: PAGES_HOOK, method: 'GET' } })
  assert.equal(
    find(buildSection(reopened), byClass('op-advanced-toggle')).getAttr('aria-expanded'),
    'true',
    'nothing the user chose is hidden behind a closed section',
  )
})

test('the check button refuses an unfinished form before making a request', async () => {
  const { root, plugin } = open({ builder: { url: PAGES_HOOK, siteUrl: '' } })
  click(find(rowNamed(root, 'Check the site'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(plugin.calls.builderChecks, 0)
})

test('a host the site was never published from says so, and keeps saying it', () => {
  const { root } = open({
    builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' },
    lastSnapshotId: 'snap-1',
    lastPublishedHostTarget: 'cloudflare-pages|https://x.pages.dev',
  })
  const warning = find(root, byClass('op-host-moved'))
  assert.ok(warning, 'the old host keeps serving, so nothing breaks and nobody finds out')
  assert.match(warning.textContent, /still being served by the host you last published to/)
  assert.match(warning.textContent, /needs the same variables as the old one/)
})

test('no such warning when this is the host that was published from', () => {
  const { root } = open({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(find(root, byClass('op-host-moved')), null)
})
