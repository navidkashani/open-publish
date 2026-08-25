import test from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, uriEncode, sha256Hex, EMPTY_PAYLOAD_SHA256 } from '../src/destinations/sigv4.ts'

/**
 * AWS's own published example ("Signature Calculations for the Authorization
 * Header: GET Object"). If our signer reproduces this byte for byte, it is
 * correct — this is the single most valuable test in the suite, because a
 * signing bug shows up as an opaque 403 with no diagnostic.
 */
test('reproduces the AWS GET Object reference signature', async () => {
  const signed = await signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    payloadHashHex: EMPTY_PAYLOAD_SHA256,
    extraSignedHeaders: { range: 'bytes=0-9' },
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  })

  assert.equal(
    signed.canonicalRequest,
    [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
      'x-amz-date:20130524T000000Z',
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      EMPTY_PAYLOAD_SHA256,
    ].join('\n'),
  )

  assert.match(
    signed.headers.Authorization,
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  )
  assert.match(
    signed.headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, /,
  )
})

test('signs a PUT with a real payload hash', async () => {
  const body = new TextEncoder().encode('Welcome to Amazon S3.')
  const signed = await signRequest({
    method: 'PUT',
    url: 'https://examplebucket.s3.amazonaws.com/test%24file.text',
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    payloadHashHex: await sha256Hex(body),
    now: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  })
  // AWS documents this payload hash for the PUT Object example.
  assert.ok(
    signed.canonicalRequest.endsWith('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072'),
  )
  // `$` must survive as %24 in the canonical path, not be decoded to a literal.
  assert.ok(signed.canonicalRequest.split('\n')[1] === '/test%24file.text')
})

test('canonical query string is sorted and encoded', async () => {
  const signed = await signRequest({
    method: 'GET',
    url: 'https://host.example/bucket?prefix=objects/&list-type=2&max-keys=1000',
    region: 'auto',
    service: 's3',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    payloadHashHex: EMPTY_PAYLOAD_SHA256,
  })
  assert.equal(signed.canonicalRequest.split('\n')[2], 'list-type=2&max-keys=1000&prefix=objects%2F')
})

test('uriEncode follows the AWS rules', () => {
  assert.equal(uriEncode('a/b c'), 'a%2Fb%20c')
  assert.equal(uriEncode('a/b c', false), 'a/b%20c')
  assert.equal(uriEncode('-_.~'), '-_.~')
  assert.equal(uriEncode('café'), 'caf%C3%A9')
  assert.equal(uriEncode('🎉'), '%F0%9F%8E%89')
  // '+' must be escaped, not treated as a space.
  assert.equal(uriEncode('a+b'), 'a%2Bb')
})

test('signature changes when the body changes', async () => {
  const base = {
    method: 'PUT',
    url: 'https://host.example/bucket/objects/ab/abc',
    region: 'auto',
    service: 's3',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    now: new Date(Date.UTC(2026, 0, 1)),
  }
  const a = await signRequest({ ...base, payloadHashHex: await sha256Hex('one') })
  const b = await signRequest({ ...base, payloadHashHex: await sha256Hex('two') })
  assert.notEqual(a.headers.Authorization, b.headers.Authorization)
})

test('host is signed but never sent — it is a forbidden header', async () => {
  const signed = await signRequest({
    method: 'GET',
    url: 'https://acct.r2.cloudflarestorage.com/bucket/current.json',
    region: 'auto',
    service: 's3',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    payloadHashHex: EMPTY_PAYLOAD_SHA256,
  })

  // Covered by the signature...
  assert.match(signed.headers.Authorization, /SignedHeaders=host;/)
  assert.ok(signed.canonicalRequest.includes('host:acct.r2.cloudflarestorage.com'))

  // ...but not handed to the transport. Electron's net, which backs Obsidian's
  // requestUrl, fails the whole request if we set Host ourselves — and it looks
  // exactly like the endpoint being unreachable.
  assert.equal(signed.headers.host, undefined)
  assert.equal(signed.headers.Host, undefined)
  assert.deepEqual(Object.keys(signed.headers).sort(), ['Authorization', 'x-amz-content-sha256', 'x-amz-date'])
})
