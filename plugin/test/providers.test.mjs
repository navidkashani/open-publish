/**
 * The catalogue is prefill, so the only things worth proving about it are the
 * ones that would quietly mislabel somebody's storage: that a value survives a
 * round trip through the endpoint it builds, that no two templates can claim
 * the same URL, and that a near miss is refused rather than guessed at.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  PROVIDERS,
  advancedChanges,
  applyProvider,
  composeEndpoint,
  docsEndpoint,
  inferProvider,
  isFreeForm,
  isProviderId,
  missingBucketHint,
  providerById,
  variableValue,
} from '../src/destinations/providers.ts'
import { advancedLabel } from '../src/ui/Disclosure.ts'

/** A realistic blank per provider, so the round trip is tested on real shapes. */
const SAMPLES = {
  r2: '0123456789abcdef0123456789abcdef',
  aws: 'eu-west-1',
  b2: 'us-west-004',
  wasabi: 'eu-central-1',
}

const templated = PROVIDERS.filter((provider) => provider.endpointTemplate !== null)

test('every provider has the copy each surface needs', () => {
  for (const provider of PROVIDERS) {
    assert.ok(provider.name, `${provider.id}: no name`)
    assert.ok(provider.summary.endsWith('.'), `${provider.id}: summary is not a sentence`)
    assert.ok(provider.concurrency.endsWith('.'), `${provider.id}: concurrency line is not a sentence`)
    assert.ok(provider.setup.length >= 3, `${provider.id}: setup steps are too thin to follow`)
    assert.ok(provider.missingBucketHint.length > 0, `${provider.id}: no hint for a missing bucket`)
    assert.equal(provider.variable.label.length > 0, true)
  }
  assert.equal(PROVIDERS.filter((provider) => provider.recommended).length, 1, 'exactly one recommendation')
  assert.equal(PROVIDERS[0].id, 'r2', 'the recommended one leads the list')
  assert.equal(PROVIDERS.at(-1).id, 'other', 'the escape hatch is last')
})

test('the gateway row names the terminal it costs, where the choice is made', () => {
  // Without it this row reads strictly better than plain R2: same bucket, same
  // site, fewer secrets on the device. The four wrangler commands are what
  // actually decides it, and the picker is the last honest place to say so.
  const gateway = PROVIDERS.find((provider) => provider.kind === 'gateway')
  assert.match(gateway.summary, /token that reaches this one bucket/)
  assert.match(gateway.summary, /terminal/)
})

test('a blank survives the round trip through the endpoint it builds', () => {
  for (const provider of templated) {
    const value = SAMPLES[provider.id]
    assert.ok(value, `${provider.id}: no sample value in this test`)
    const endpoint = composeEndpoint(provider.id, value)
    assert.deepEqual(inferProvider(endpoint), { id: provider.id, value }, `${provider.id} does not round trip`)
    assert.equal(variableValue(provider.id, endpoint), value)
  }
})

test('a sample value only ever matches its own provider', () => {
  for (const provider of templated) {
    const endpoint = composeEndpoint(provider.id, SAMPLES[provider.id])
    for (const other of templated) {
      if (other.id === provider.id) continue
      assert.notEqual(inferProvider(endpoint).id, other.id, `${other.id} claimed a ${provider.id} endpoint`)
    }
  }
})

test("a near miss is Other, not a Cloudflare link beside an attacker's endpoint", () => {
  const nearMisses = [
    'https://acct.r2.cloudflarestorage.com.attacker.net',
    'https://acct.r2.cloudflarestorage.com.evil.example/path',
    'https://r2.cloudflarestorage.com',
    'https://acct.r2.cloudflarestorage.net',
    'https://s3.eu-west-1.amazonaws.com.attacker.net',
    'https://nots3.eu-west-1.amazonaws.com',
    'https://s3.amazonaws.com',
  ]
  for (const endpoint of nearMisses) {
    assert.equal(inferProvider(endpoint).id, 'other', `${endpoint} should not be recognised`)
  }
})

test('a trailing slash is ignored, the way the signer already ignores it', () => {
  const endpoint = composeEndpoint('r2', SAMPLES.r2)
  assert.deepEqual(inferProvider(`${endpoint}/`), { id: 'r2', value: SAMPLES.r2 })
  assert.deepEqual(inferProvider(`${endpoint}///`), { id: 'r2', value: SAMPLES.r2 })
})

test('an empty or missing endpoint is Other with nothing filled in', () => {
  for (const input of ['', '   ', undefined]) {
    assert.deepEqual(inferProvider(input), { id: 'other', value: '' })
  }
})

test('a half-typed blank never builds a half-built URL', () => {
  assert.equal(composeEndpoint('r2', ''), '', 'https://.r2.cloudflarestorage.com would look configured and resolve nowhere')
  assert.equal(composeEndpoint('aws', '  '), '')
})

test('free-form providers pass the endpoint straight through', () => {
  assert.equal(isFreeForm('minio'), true)
  assert.equal(isFreeForm('other'), true)
  assert.equal(isFreeForm('r2'), false)
  assert.equal(composeEndpoint('minio', 'http://localhost:9000/'), 'http://localhost:9000')
  assert.equal(variableValue('other', 'https://files.example.com'), 'https://files.example.com')
})

test('an unknown provider id is a label problem, never a crash', () => {
  assert.equal(providerById('tigris').id, 'other')
  assert.equal(providerById(undefined).id, 'other')
  assert.equal(isProviderId('tigris'), false)
  assert.equal(isProviderId('r2'), true)
  assert.equal(composeEndpoint('tigris', 'https://fly.storage.tigris.dev'), 'https://fly.storage.tigris.dev')
})

// --- switching -----------------------------------------------------------

const target = (over = {}) => ({
  provider: 'r2',
  endpoint: composeEndpoint('r2', SAMPLES.r2),
  region: 'auto',
  forcePathStyle: true,
  ...over,
})

test('picking the provider you are already on changes nothing at all', () => {
  const before = target()
  assert.equal(applyProvider(before, 'r2'), before, 'not even a hand-edited endpoint is rewritten')
})

test('switching to a different template clears the blank rather than reusing it', () => {
  const after = applyProvider(target(), 'aws')
  assert.equal(after.endpoint, '', 'an account ID is not a region')
  assert.equal(after.region, 'auto')
  assert.equal(after.forcePathStyle, false, 'AWS is the one provider that is not path-style')
})

test('switching to a free-form provider keeps the endpoint, since no template disagrees', () => {
  const after = applyProvider(target(), 'other')
  assert.equal(after.endpoint, composeEndpoint('r2', SAMPLES.r2))
  const minio = applyProvider(target({ provider: 'other', endpoint: 'http://localhost:9000' }), 'minio')
  assert.equal(minio.endpoint, 'http://localhost:9000')
  assert.equal(minio.region, 'us-east-1')
})

test('switching back onto a template that matches the endpoint recovers the blank', () => {
  const asOther = applyProvider(target(), 'other')
  const back = applyProvider(asOther, 'r2')
  assert.equal(back.endpoint, composeEndpoint('r2', SAMPLES.r2), 'the round trip holds by construction')
  assert.equal(back.region, 'auto')
})

test('a region provider takes its signing region from the blank', () => {
  const aws = applyProvider(target({ provider: 'other', endpoint: composeEndpoint('aws', 'us-east-2') }), 'aws')
  assert.equal(aws.region, 'us-east-2')
  assert.equal(aws.endpoint, 'https://s3.us-east-2.amazonaws.com')
})

// --- Advanced ------------------------------------------------------------

test('every field at its provider default leaves Advanced with nothing to show', () => {
  const changes = advancedChanges('r2', { endpoint: composeEndpoint('r2', SAMPLES.r2), region: 'auto' })
  assert.deepEqual(changes, [])
  assert.equal(advancedLabel(changes), 'Advanced')
})

test('anything the user chose is named on the label, so a closed section is never opaque', () => {
  const one = advancedChanges('r2', { endpoint: composeEndpoint('r2', SAMPLES.r2), region: 'auto', prefix: 'notes' })
  assert.deepEqual(one, ['key prefix "notes"'])
  assert.equal(advancedLabel(one), 'Advanced · key prefix "notes"')

  const two = advancedChanges('r2', {
    endpoint: composeEndpoint('r2', SAMPLES.r2),
    region: 'auto',
    prefix: 'notes',
    forcePathStyle: false,
  })
  assert.equal(advancedLabel(two), 'Advanced · 2 fields changed')
})

test('a hand-edited endpoint counts as changed, because it outranks the template', () => {
  const changes = advancedChanges('r2', { endpoint: 'https://notes.example.com', region: 'auto' })
  assert.deepEqual(changes, ['custom endpoint'])
})

test('the region is not double-counted on providers where it is the blank', () => {
  const changes = advancedChanges('aws', {
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    region: 'eu-west-1',
    forcePathStyle: false,
  })
  assert.deepEqual(changes, [], 'the region field is the visible one, not an advanced one')
})

test('path-style is measured against the provider, not against a global default', () => {
  assert.deepEqual(advancedChanges('aws', { endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', forcePathStyle: true }), [
    'path-style on',
  ])
  assert.deepEqual(advancedChanges('r2', { endpoint: composeEndpoint('r2', SAMPLES.r2), region: 'auto', forcePathStyle: false }), [
    'path-style off',
  ])
})

// --- the parts that talk to the rest of the repo -------------------------

test('a missing bucket is explained in terms of the provider actually in use', () => {
  assert.match(missingBucketHint(composeEndpoint('r2', SAMPLES.r2)), /account ID/)
  assert.match(missingBucketHint(composeEndpoint('aws', SAMPLES.aws)), /region/)
  assert.doesNotMatch(missingBucketHint(composeEndpoint('aws', SAMPLES.aws)), /R2|account ID/)
  assert.doesNotMatch(missingBucketHint('https://files.example.com'), /R2|account ID/)
})

test('the docs table and the catalogue cannot drift apart', () => {
  const docs = readFileSync(new URL('../../docs/other-providers.md', import.meta.url), 'utf8')
  const rows = docs.split('\n').filter((line) => line.startsWith('|'))

  for (const provider of PROVIDERS) {
    const row = rows.find((line) => line.includes(provider.name))
    assert.ok(row, `docs/other-providers.md has no row for ${provider.name}`)

    const endpoint = docsEndpoint(provider.id)
    if (endpoint) {
      assert.ok(row.includes(endpoint), `${provider.name}: the docs endpoint is not \`${endpoint}\``)
    }
  }

  assert.match(docs, /90[- ]day/, 'the Wasabi deletion charge belongs in the docs too')
})
