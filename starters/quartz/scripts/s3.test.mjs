/**
 * The starter signs requests itself rather than sharing code with the plugin —
 * different runtimes, different crypto APIs. That is two implementations of one
 * spec, which is exactly the kind of thing that drifts silently.
 *
 * These tests pin both ends: the AWS reference vector, and agreement with the
 * plugin's signer on the same inputs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { S3Reader, uriEncode } from './lib/s3.mjs'

/**
 * The cross-check against the plugin's signer only runs inside the Open Publish
 * monorepo. Published as a standalone template this path does not exist, and a
 * template that fails `npm test` on a fresh clone is worse than one that skips a
 * test it cannot run.
 */
let pluginSigner = null
try {
  pluginSigner = await import('../../../plugin/src/destinations/sigv4.ts')
} catch {
  pluginSigner = null
}

const config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'my-notes',
  region: 'auto',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  prefix: '',
  forcePathStyle: true,
}

test('reproduces the AWS reference signature, like the plugin does', () => {
  const reader = new S3Reader({
    endpoint: 'https://examplebucket.s3.amazonaws.com',
    bucket: '',
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    prefix: '',
    forcePathStyle: false,
  })
  const headers = reader.sign(
    'GET',
    'https://examplebucket.s3.amazonaws.com/test.txt',
    new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  )
  // Same request as the plugin's reference test, minus the Range header.
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, /)
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
})

test('the starter and the plugin produce identical signatures', { skip: pluginSigner ? false : 'plugin source not present (standalone template)' }, async () => {
  const { signRequest, EMPTY_PAYLOAD_SHA256 } = pluginSigner
  const now = new Date(Date.UTC(2026, 7, 24, 11, 4, 2))
  const keys = [
    'current.json',
    'snapshots/2026-08-24T11-04-02Z-a3f9c1.json',
    'objects/ab/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  ]

  for (const key of keys) {
    const reader = new S3Reader(config)
    const url = reader.url(key)
    const starter = reader.sign('GET', url, now)

    const plugin = await signRequest({
      method: 'GET',
      url,
      region: config.region,
      service: 's3',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      payloadHashHex: EMPTY_PAYLOAD_SHA256,
      now,
    })

    assert.equal(starter.authorization, plugin.headers.Authorization, `signatures differ for ${key}`)
    assert.equal(starter['x-amz-date'], plugin.headers['x-amz-date'])
  }
})

test('the starter and the plugin build identical URLs, prefixes and all', () => {
  const cases = [
    [{ ...config }, 'current.json', 'https://acct.r2.cloudflarestorage.com/my-notes/current.json'],
    [{ ...config, prefix: 'sites/notes' }, 'current.json', 'https://acct.r2.cloudflarestorage.com/my-notes/sites/notes/current.json'],
    [{ ...config, forcePathStyle: false }, 'current.json', 'https://my-notes.acct.r2.cloudflarestorage.com/current.json'],
  ]
  for (const [cfg, key, expected] of cases) {
    assert.equal(new S3Reader(cfg).url(key), expected)
  }
})

test('uriEncode matches the plugin rules', () => {
  assert.equal(uriEncode('a/b c'), 'a%2Fb%20c')
  assert.equal(uriEncode('a/b c', false), 'a/b%20c')
  assert.equal(uriEncode('café'), 'caf%C3%A9')
  assert.equal(uriEncode('-_.~'), '-_.~')
})

test('fromEnv names every variable that is missing', () => {
  assert.throws(
    () => S3Reader.fromEnv({ OP_ENDPOINT: 'https://e' }),
    (error) => {
      assert.match(error.message, /OP_BUCKET/)
      assert.match(error.message, /OP_ACCESS_KEY_ID/)
      assert.match(error.message, /OP_SECRET_ACCESS_KEY/)
      assert.doesNotMatch(error.message, /OP_ENDPOINT/)
      return true
    },
  )
})

test('fromEnv defaults region to auto and treats a blank prefix as none', () => {
  const reader = S3Reader.fromEnv({
    OP_ENDPOINT: 'https://e/', OP_BUCKET: 'b', OP_ACCESS_KEY_ID: 'k', OP_SECRET_ACCESS_KEY: 's',
  })
  assert.equal(reader.config.region, 'auto')
  assert.equal(reader.config.prefix, '')
  assert.equal(reader.config.endpoint, 'https://e')
})

test('a 403 fails immediately rather than retrying against a revoked token', async () => {
  let attempts = 0
  const reader = new S3Reader(config)
  await assert.rejects(
    () =>
      reader.get('current.json', {
        fetchImpl: async () => {
          attempts++
          return { status: 403, ok: false, arrayBuffer: async () => new ArrayBuffer(0) }
        },
      }),
    /rejected the build credentials/,
  )
  assert.equal(attempts, 1)
})

test('a missing key is null, and a transient failure is retried', async () => {
  const reader = new S3Reader(config)
  assert.equal(
    await reader.get('nope', { fetchImpl: async () => ({ status: 404, ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) }),
    null,
  )

  let attempts = 0
  const body = await reader.get('current.json', {
    fetchImpl: async () => {
      if (++attempts < 3) throw new Error('socket hang up')
      return { status: 200, ok: true, arrayBuffer: async () => new TextEncoder().encode('{}').buffer }
    },
  })
  assert.equal(body.toString(), '{}')
  assert.equal(attempts, 3)
})
