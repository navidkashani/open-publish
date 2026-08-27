/**
 * The one boundary between a name and a credential.
 *
 * `main.ts` stores the *name* of a keychain entry in `data.json` and resolves it
 * to the real value at the single point where a destination is constructed.
 * `S3Config` and `GatewayConfig` did not change, which is why `s3.test.mjs`,
 * `gateway.test.mjs` and `sigv4.test.mjs` did not have to: below this line
 * everything still takes a real key. This file covers the line itself.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenPublishPlugin, fakeApp, modals, notices } from './harness.mjs'
import { migrateSettings } from '../src/settings.ts'

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'

/**
 * A plugin far enough along to answer `destination()`.
 *
 * `onload` is never called: it reads `data.json` and registers commands, and
 * neither is anything to do with turning a name into a credential.
 */
function plugin({ destination, secrets = {} }) {
  const instance = new OpenPublishPlugin()
  instance.app = fakeApp({ secrets })
  // The undocumented settings API `openSettings()` reaches for. Present so the
  // bounce below lands where it means to instead of falling to its own
  // "could not open settings from here" notice.
  instance.app.setting = { open() {}, openTabById() {} }
  instance.settings = migrateSettings({ destination })
  instance.manifest = { id: 'open-publish', version: '0.1.0', dir: '.obsidian/plugins/open-publish' }
  return instance
}

const s3 = (extra = {}) => ({
  endpoint: R2_ENDPOINT,
  bucket: 'my-notes',
  accessKeyId: 'AKIA',
  secretRef: 'op-r2-secret',
  ...extra,
})

test('a stored name is resolved to the key that actually signs', () => {
  const app = plugin({ destination: s3(), secrets: { 'op-r2-secret': 'the-real-key' } })
  // Reaching into the config on purpose: this asserts the one thing the whole
  // change turns on, which is that the value handed to the signer is the one
  // from the keychain and not the name from `data.json`.
  assert.equal(app.destination().config.secretAccessKey, 'the-real-key')
  assert.equal(app.destination().config.accessKeyId, 'AKIA', 'the identifier still comes from settings')
})

test('the gateway resolves the same way, into the token the Worker checks', () => {
  const app = plugin({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
    secrets: { 'op-gateway-token': 'the-real-token' },
  })
  assert.equal(app.destination().config.token, 'the-real-token')
})

test('a name this device cannot resolve fails in a sentence, not at the signature', () => {
  // The ordinary state of a second device: `data.json` syncs and the keychain
  // does not. Left to fall through, an empty key would reach storage as a
  // signature failure, which reads back as "your keys were rejected" and sends
  // people off to reissue credentials that were never wrong.
  const app = plugin({ destination: s3(), secrets: {} })
  assert.throws(
    () => app.destination(),
    (error) => {
      assert.equal(error.code, 'not-configured')
      assert.match(error.message, /no secret named "op-r2-secret"/)
      assert.match(error.hint, /each device separately/)
      return true
    },
  )
})

test('an empty name is refused before resolution is even attempted', () => {
  const app = plugin({ destination: s3({ secretRef: '' }) })
  assert.throws(() => app.destination(), /Storage is not set up yet/)
})

test('rotating the key behind an unchanged name rebuilds the destination', () => {
  // The bug this test exists for. The cache used to be keyed on the settings
  // alone, which held the key, so editing it rebuilt. Now the settings hold
  // only a name, and a name does not change when the value behind it does: a
  // cache that watched settings alone would keep signing with the old key until
  // Obsidian restarted, failing on credentials the user had already fixed.
  const secrets = { 'op-r2-secret': 'first-key' }
  const app = plugin({ destination: s3(), secrets })

  const before = app.destination()
  assert.equal(app.destination(), before, 'an unchanged configuration is still reused')

  secrets['op-r2-secret'] = 'second-key'
  const after = app.destination()
  assert.notEqual(after, before, 'a rotated key is a different destination')
  assert.equal(after.config.secretAccessKey, 'second-key')
})

test('the destination is still reused across calls, which is the point of caching it', () => {
  // `S3Destination` learns as it goes that a provider ignores conditional
  // writes, and a fresh instance per call throws that away: every publish would
  // rediscover it by burning three retries with backoff.
  const app = plugin({ destination: s3(), secrets: { 'op-r2-secret': 'the-real-key' } })
  const first = app.destination()
  assert.equal(app.destination(), first)

  app.settings.destination.bucket = 'a-different-bucket'
  assert.notEqual(app.destination(), first, 'an edited setting still rebuilds, exactly as before')
})

// --- what happens before the publish window opens -------------------------

test('a device without the key is told so instead of being shown a scan that cannot finish', () => {
  // The ordinary state of the second device somebody syncs a vault to, and the
  // reason it is caught here: every field is filled in, so the check one line
  // above this passes, and the failure would otherwise arrive after a scan that
  // never had a chance.
  const app = plugin({ destination: s3(), secrets: {} })
  const before = modals.length

  app.openPublishModal()

  assert.equal(modals.length, before, 'no publish window, because there is nothing it could do')
  assert.match(notices.at(-1), /does not have the storage key for this vault yet/)
  assert.match(notices.at(-1), /keeps keys on each device separately/, 'and why, so it does not read as a fault')
})

test('the window still opens for a device that has it', () => {
  const app = plugin({ destination: s3(), secrets: { 'op-r2-secret': 'the-real-key' } })
  const before = modals.length

  app.openPublishModal()

  assert.equal(modals.length, before + 1)
})

test('a vault with nothing filled in still goes to the setup guide, not to settings', () => {
  // The two states are different questions. Nothing filled in is "set this up";
  // a name this device cannot resolve is "you already did, elsewhere".
  const app = plugin({ destination: s3({ secretRef: '', bucket: '' }) })
  app.openPublishModal()
  assert.match(notices.at(-1), /needs storage details first/)
})
