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

// --- choosing a host ------------------------------------------------------

const NETLIFY_HOOK = 'https://api.netlify.com/build_hooks/68a1f0c2d3e4b5a6c7d8e9f0'
const PAGES_HOOK = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/0f7a1c2e3b4d5e6f'

const hostRows = (wizard) => findAll(wizard.contentEl, byClass('op-provider-row'))
const hostNamed = (wizard, name) =>
  hostRows(wizard).find((row) => find(row, byClass('op-provider-name'))?.textContent === name)

test('step 4 offers every host, marks one, and says what each free plan gives you', () => {
  const { wizard } = open()
  goTo(wizard, 3)
  const rows = hostRows(wizard)
  assert.equal(rows.length, 5)

  const badges = findAll(wizard.contentEl, byClass('op-provider-badge'))
  assert.equal(badges.length, 1, 'exactly one recommendation, or it is not a recommendation')
  assert.equal(find(hostNamed(wizard, 'Cloudflare Pages'), byClass('op-provider-badge')).textContent, 'Recommended')
  assert.match(find(hostNamed(wizard, 'Netlify'), byClass('op-provider-summary')).textContent, /20 deploys a month/)
})

test('picking a host swaps the instructions, which is the whole mechanism', () => {
  const { wizard, plugin } = open()
  goTo(wizard, 3)
  assert.match(wizard.contentEl.textContent, /Framework preset: None/)

  click(hostNamed(wizard, 'Netlify'))

  assert.equal(plugin.settings.builder.host, 'netlify')
  assert.match(wizard.contentEl.textContent, /Publish directory: public/)
  assert.doesNotMatch(wizard.contentEl.textContent, /Framework preset: None/)
  assert.equal(hostNamed(wizard, 'Netlify').getAttr('aria-pressed'), 'true')
  assert.equal(hostNamed(wizard, 'Cloudflare Pages').getAttr('aria-pressed'), 'false')
})

test('a host that provides no site address gets one in its environment block', () => {
  // Otherwise Quartz falls back to example.com and the feed, the sitemap and
  // the 404 page all ship pointing at a domain the user does not own.
  const { wizard } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretAccessKey: 's' },
    builder: { host: 'cloudflare-workers', siteUrl: 'https://notes.example.com' },
  })
  goTo(wizard, 3)
  assert.match(envBlock(wizard), /OP_SITE_URL=https:\/\/notes\.example\.com/)

  const { wizard: onPages } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  goTo(onPages, 3)
  assert.doesNotMatch(envBlock(onPages), /OP_SITE_URL/, 'Pages reports its own address')
})

test('the escape-hatch host gets OP_SITE_URL in the block it tells you to paste', () => {
  // "Another host" is where every unrecognised deploy hook lands, and it is the
  // one host with no WORKERS_CI guard behind it, so an environment block that
  // omits OP_SITE_URL is a site quietly built as example.com.
  const { wizard } = open({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' },
    builder: { host: 'other', siteUrl: 'https://notes.example.com' },
  })
  goTo(wizard, 3)
  assert.match(envBlock(wizard), /OP_SITE_URL=https:\/\/notes\.example\.com/)
  assert.match(wizard.contentEl.textContent, /Set OP_SITE_URL to your site address/, 'and the steps agree with it')
})

test('the custom domain trap is named where the variables are handed over', () => {
  const { wizard } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  goTo(wizard, 3)
  assert.match(wizard.contentEl.textContent, /custom domain/)
  assert.match(wizard.contentEl.textContent, /feed and sitemap/)
})

test('choosing a host leaves every value that governs a build alone', () => {
  const { wizard, plugin } = open({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev', minIntervalMinutes: 30, autoTrigger: false },
  })
  goTo(wizard, 3)
  click(hostNamed(wizard, 'Vercel'))

  const builder = plugin.settings.builder
  assert.equal(builder.host, 'vercel')
  assert.equal(builder.url, PAGES_HOOK, 'a deploy hook URL can only be pasted, never derived')
  assert.equal(builder.siteUrl, 'https://x.pages.dev')
  assert.equal(builder.minIntervalMinutes, 30)
  assert.equal(builder.autoTrigger, false)
})

// --- the deploy hook step -------------------------------------------------

test("step 5 gives the chosen host's own instructions, and no picker", () => {
  const { wizard } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  goTo(wizard, 4)
  assert.match(wizard.contentEl.textContent, /Build & deploy → Build hooks/)
  assert.equal(settingNamed(wizard.contentEl, 'Hosting provider'), null, 'step 4 already chose; Back is how you change it')
  assert.ok(settingNamed(wizard.contentEl, 'Deploy hook URL'))
  assert.ok(settingNamed(wizard.contentEl, 'Site URL'))
})

test('every host is told to create the hook for the branch the site is built from', () => {
  // A hook on the wrong branch deploys a preview while the plugin polls
  // production, so the check never matches and a publish waits the full ten
  // minutes before saying anything.
  for (const stored of [{ url: PAGES_HOOK }, { url: NETLIFY_HOOK }, { host: 'vercel' }, { host: 'other' }]) {
    const { wizard } = open({ builder: stored })
    goTo(wizard, 4)
    assert.match(wizard.contentEl.textContent, /branch/, `${stored.host ?? stored.url} says nothing about the branch`)
  }
})

test("the allowance panel reaches the wizard too, before a month has been spent", () => {
  const { wizard } = open({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  goTo(wizard, 4)
  assert.match(find(wizard.contentEl, byClass('op-build-allowance')).textContent, /about 20 site updates a month/)

  const { wizard: onPages } = open({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  goTo(onPages, 4)
  assert.equal(find(onPages.contentEl, byClass('op-build-allowance')), null)
})

test('the check result lands in the step, not in a toast over the top of it', async () => {
  const { wizard, plugin } = open({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  goTo(wizard, 4)
  click(find(settingNamed(wizard.contentEl, 'Check the site'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.calls.builderChecks, 1)
  const result = find(wizard.contentEl, byClass('op-wizard-result'))
  assert.match(result.textContent, /Site is reachable/)
  assert.equal(result.hasClass('op-notice-ok'), true)
})

test('an unfinished form is refused before a request is ever made', async () => {
  const { wizard, plugin } = open({ builder: { url: PAGES_HOOK } })
  goTo(wizard, 4)
  click(find(settingNamed(wizard.contentEl, 'Check the site'), (node) => node.tagName === 'BUTTON'))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.calls.builderChecks, 0)
  assert.match(find(wizard.contentEl, byClass('op-wizard-result')).textContent, /Fill in the deploy hook URL/)
})

test('the hook and site fields on step 5 write straight through to settings', () => {
  const { wizard, plugin } = open()
  goTo(wizard, 4)
  const site = find(settingNamed(wizard.contentEl, 'Site URL'), (node) => node.tagName === 'INPUT')
  site.value = ' https://x.pages.dev/ '
  dispatch(site, 'input')
  assert.equal(plugin.settings.builder.siteUrl, 'https://x.pages.dev')
  assert.ok(plugin.calls.saves > 0)
})

test('the setup guide is still six steps, so "step 4" keeps meaning the same thing', () => {
  // `STORAGE_MOVED_WARNING` and `HOST_MOVED_WARNING` both send people to step 4
  // for the environment variables, and both would be wrong if this changed.
  const { wizard } = open()
  assert.match(wizard.contentEl.textContent, /Step 1 of 6/)
  goTo(wizard, 3)
  assert.match(wizard.contentEl.textContent, /Step 4 of 6/)
  assert.ok(envBlock(wizard).includes('OP_ENDPOINT'), 'and step 4 is still the one with the variables')
})
