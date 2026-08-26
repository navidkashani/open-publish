/**
 * The sentences attached to the platform limits.
 *
 * There is no scanner test to hang these off: a scan needs a vault. So the copy
 * lives in `limits.ts`, next to the numbers it explains, and this is what makes
 * it reachable. The bug being locked down is a specific one: two of these
 * messages *block a publish*, and both used to name Cloudflare Pages, so a
 * Netlify user was stopped and told about a product they had never used.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ASSET_BYTES,
  MAX_FILE_COUNT,
  MAX_UPLOAD_BYTES,
  MiB,
  WARN_FILE_COUNT,
  WARN_SNAPSHOT_BYTES,
  formatBytes,
  largeSnapshotWarning,
  nearFileLimitWarning,
  tooLargeToServeMessage,
  tooLargeToUploadMessage,
  tooManyFilesMessage,
} from '../src/core/limits.ts'

const everyMessage = () => [
  tooLargeToUploadMessage('Attachments/talk.mov', 200 * MiB),
  tooLargeToServeMessage('Attachments/talk.mov', 30 * MiB),
  tooManyFilesMessage(19_001),
  nearFileLimitWarning(15_001),
  largeSnapshotWarning(600 * MiB),
]

test('no limit names a host, least of all the two that block a publish', () => {
  for (const message of everyMessage()) {
    assert.doesNotMatch(message, /Cloudflare|Pages|Netlify|Vercel|R2/, `"${message}" names a vendor`)
  }
})

test('each one says what is wrong and what to do about it', () => {
  for (const message of everyMessage()) {
    assert.ok(message.endsWith('.'), `"${message}" is not a sentence`)
  }
  assert.match(tooLargeToServeMessage('a.mov', 30 * MiB), /shrink it/)
  assert.match(tooManyFilesMessage(19_001), /Narrow the include rules/)
})

test('the size in the message is the file, and the limit is the wall it hit', () => {
  const message = tooLargeToServeMessage('Attachments/talk.mov', 30 * MiB)
  assert.match(message, /"Attachments\/talk\.mov" is 30\.0 MB/)
  assert.match(message, new RegExp(formatBytes(MAX_ASSET_BYTES).replace('.', '\\.')))

  assert.match(tooLargeToUploadMessage('big.zip', 200 * MiB), /200\.0 MB/)
  assert.match(tooLargeToUploadMessage('big.zip', 200 * MiB), new RegExp(formatBytes(MAX_UPLOAD_BYTES).replace('.', '\\.')))
})

test('the counts read as counts, not as internal constants', () => {
  assert.match(tooManyFilesMessage(19_001), /^19001 files selected\./)
  assert.match(nearFileLimitWarning(15_001), /^15001 files selected,/)
})

test('the numbers themselves are unchanged: this was a wording fix, not a policy one', () => {
  assert.equal(MAX_ASSET_BYTES, 25 * MiB)
  assert.equal(MAX_UPLOAD_BYTES, 100 * MiB)
  assert.equal(WARN_FILE_COUNT, 15000)
  assert.equal(MAX_FILE_COUNT, 19000)
  assert.equal(WARN_SNAPSHOT_BYTES, 500 * MiB)
})
