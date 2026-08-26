/**
 * The setup guide, driven by the storage catalogue.
 *
 * Step 1 is a picker whose instructions swap with the choice, step 2 is the
 * shared form, and step 4 hands over the environment variables the build reads.
 * That last one is where a real bug lived: the block never emitted
 * `OP_FORCE_PATH_STYLE`, so turning the toggle off produced a plugin and a
 * build that disagreed about where objects live.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SetupWizard, fakeApp, fakeStoragePlugin } from './harness.mjs'
import { byClass, click, dispatch, find, findAll, visible } from './dom.mjs'

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'

function open(stored = {}) {
  const app = fakeApp({ files: ['Notes/Home.md'], folders: ['Notes'] })
  const plugin = fakeStoragePlugin({ stored })
  const wizard = new SetupWizard(app, plugin)
  wizard.open()
  return { wizard, plugin }
}

const providerRows = (wizard) => findAll(wizard.contentEl, byClass('op-provider-row'))
const rowNamed = (wizard, name) =>
  providerRows(wizard).find((row) => find(row, byClass('op-provider-name'))?.textContent === name)

function goTo(wizard, stepIndex) {
  for (let i = 0; i < stepIndex; i++) {
    click(find(wizard.contentEl, (node) => node.tagName === 'BUTTON' && node.hasClass('mod-cta') && node.textContent === 'Next'))
  }
}

const settingNamed = (root, name) =>
  find(root, (node) => node.hasClass('setting-item') && find(node, byClass('setting-item-name'))?.textContent === name)

test('step 1 offers every provider, marks one, and says what each costs', () => {
  const { wizard } = open()
  const rows = providerRows(wizard)
  assert.equal(rows.length, 6)
  assert.match(wizard.contentEl.textContent, /Choose your storage/)

  const badges = findAll(wizard.contentEl, byClass('op-provider-badge'))
  assert.equal(badges.length, 1, 'exactly one recommendation, or it is not a recommendation')
  assert.equal(badges[0].textContent, 'Recommended')
})

test('each row is a real button with a pressed state, so Tab and Enter reach it', () => {
  const { wizard } = open()
  for (const row of providerRows(wizard)) {
    assert.equal(row.tagName, 'BUTTON')
    assert.ok(row.hasAttribute('aria-pressed'))
  }
  const pressed = providerRows(wizard).filter((row) => row.getAttr('aria-pressed') === 'true')
  assert.equal(pressed.length, 1)
  assert.equal(find(pressed[0], byClass('op-provider-name')).textContent, 'Cloudflare R2')
})

test('picking a provider swaps the instructions, which is the whole mechanism', () => {
  const { wizard, plugin } = open()
  assert.match(wizard.contentEl.textContent, /R2 overview page/)

  click(rowNamed(wizard, 'Backblaze B2'))

  assert.equal(plugin.settings.destination.provider, 'b2')
  assert.match(wizard.contentEl.textContent, /Application Keys/)
  assert.doesNotMatch(wizard.contentEl.textContent, /R2 overview page/)
  assert.equal(rowNamed(wizard, 'Backblaze B2').getAttr('aria-pressed'), 'true')
  assert.equal(rowNamed(wizard, 'Cloudflare R2').getAttr('aria-pressed'), 'false')
})

test('Wasabi states its deletion charge on the row itself, before anyone commits', () => {
  const { wizard } = open()
  const row = rowNamed(wizard, 'Wasabi')
  assert.match(find(row, byClass('op-provider-caution-line')).textContent, /90 days/)
})

test("step 2 asks for the chosen provider's blank, not for an endpoint", () => {
  const { wizard } = open()
  goTo(wizard, 1)
  assert.ok(settingNamed(wizard.contentEl, 'Account ID'))
  assert.ok(settingNamed(wizard.contentEl, 'Bucket'))
  assert.equal(visible(settingNamed(wizard.contentEl, 'Endpoint')), false, 'the raw endpoint is behind Advanced')
  assert.equal(settingNamed(wizard.contentEl, 'Storage provider'), null, 'step 1 already chose; Back is how you change it')
})

test('a test result lands in the step, not in a toast over the top of it', async () => {
  const app = fakeApp({ files: [], folders: [] })
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } },
    testResult: { ok: true, conditionalWrites: 'enforced' },
  })
  const wizard = new SetupWizard(app, plugin)
  wizard.open()
  goTo(wizard, 1)

  click(find(settingNamed(wizard.contentEl, 'Test connection'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  const result = find(wizard.contentEl, byClass('op-wizard-result'))
  assert.match(result.textContent, /Two devices can publish safely/)
  assert.equal(result.hasClass('op-notice-ok'), true)
})

test('an unfinished form is refused before a request is ever made', async () => {
  const { wizard, plugin } = open()
  goTo(wizard, 1)
  click(find(settingNamed(wizard.contentEl, 'Test connection'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.calls.tests, 0)
  assert.match(find(wizard.contentEl, byClass('op-wizard-result')).textContent, /Fill in every field/)
})

// --- the environment variables the build actually reads -------------------

const envBlock = (wizard) => find(wizard.contentEl, (node) => node.tagName === 'PRE').textContent

test('the variables carry everything the build needs to find the same objects', () => {
  const { wizard } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', region: 'auto', accessKeyId: 'k', secretAccessKey: 's' },
  })
  goTo(wizard, 3)
  const env = envBlock(wizard)
  assert.match(env, /OP_ENDPOINT=https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com/)
  assert.match(env, /OP_BUCKET=my-notes/)
  assert.match(env, /OP_REGION=auto/)
  assert.doesNotMatch(env, /OP_PREFIX/, 'no prefix, so no line about one')
  assert.doesNotMatch(env, /OP_FORCE_PATH_STYLE/, 'the build already defaults path-style on')
})

test('turning path-style off is passed on, or the build silently reads the wrong URLs', () => {
  // The bug this test exists for: the plugin wrote `bucket.endpoint/key` while
  // the build read `endpoint/bucket/key`. The publish succeeded and the site
  // then could not find current.json, one step after the mistake and on a
  // machine the user cannot see.
  const { wizard } = open({
    destination: {
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      bucket: 'my-notes',
      region: 'eu-west-1',
      forcePathStyle: false,
      accessKeyId: 'k',
      secretAccessKey: 's',
    },
  })
  goTo(wizard, 3)
  assert.match(envBlock(wizard), /OP_FORCE_PATH_STYLE=false/)
})

test('a key prefix still travels with the rest', () => {
  const { wizard } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes', accessKeyId: 'k', secretAccessKey: 's' },
  })
  goTo(wizard, 3)
  assert.match(envBlock(wizard), /OP_PREFIX=notes/)
})

test('choosing a provider in the wizard leaves the bucket and keys alone', () => {
  const { wizard, plugin } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretAccessKey: 'shh' },
  })
  click(rowNamed(wizard, 'Amazon S3'))

  const destination = plugin.settings.destination
  assert.equal(destination.bucket, 'my-notes')
  assert.equal(destination.accessKeyId, 'AKIA')
  assert.equal(destination.secretAccessKey, 'shh')
  assert.equal(destination.forcePathStyle, false, 'AWS is the one provider that is not path-style')
})

test('the storage fields on step 2 write straight through to settings', () => {
  const { wizard, plugin } = open()
  goTo(wizard, 1)
  const bucket = find(settingNamed(wizard.contentEl, 'Bucket'), (node) => node.tagName === 'INPUT')
  bucket.value = ' my-notes '
  dispatch(bucket, 'input')
  assert.equal(plugin.settings.destination.bucket, 'my-notes')
  assert.ok(plugin.calls.saves > 0)
})

test('the step says it is working before it says what it found', async () => {
  const app = fakeApp({ files: [], folders: [] })
  let release
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' } },
  })
  plugin.testDestination = () => new Promise((resolve) => { release = () => resolve({ ok: true, conditionalWrites: 'enforced' }) })

  const wizard = new SetupWizard(app, plugin)
  wizard.open()
  goTo(wizard, 1)
  click(find(settingNamed(wizard.contentEl, 'Test connection'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(find(wizard.contentEl, byClass('op-wizard-result')).textContent, /Testing/)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(find(wizard.contentEl, byClass('op-wizard-result')).textContent, /Connected/)
})
