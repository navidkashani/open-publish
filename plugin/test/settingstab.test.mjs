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
import { OpenPublishSettingTab, fakeApp, fakeStoragePlugin } from './harness.mjs'
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
  assert.equal(toggle.textContent, 'Advanced · 2 settings changed')
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
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
  })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'aws'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.bucket, 'my-notes')
  assert.equal(plugin.settings.destination.accessKeyId, 'AKIA')
  assert.equal(plugin.settings.destination.secretAccessKey, 'shh')
  assert.equal(plugin.settings.destination.provider, 'aws')
  assert.equal(plugin.settings.destination.endpoint, '', 'an account ID is not a region, so it is not carried over')
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
  assert.match(find(root, byClass('op-advanced-toggle')).textContent, /2 settings changed/)
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
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } },
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
    destination: { endpoint: R2_ENDPOINT, bucket: 'new-bucket', accessKeyId: 'k', secretAccessKey: 's' },
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
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretAccessKey: 's' },
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
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } },
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
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } },
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
