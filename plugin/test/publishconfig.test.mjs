/**
 * Reading somebody else's file.
 *
 * `publish.json` is written by Obsidian Publish, which means every assumption
 * here is about a format we do not control and cannot version. The first test
 * is a real file, copied off a live vault, because a parser for a foreign
 * format is only worth as much as the sample it was written against.
 *
 * The blank-entry test is the one that matters most. `matchesFolderRule`
 * returns true for every path when the rule is empty, so a single `""` in
 * `included` would publish an entire vault. That is the accident this whole
 * feature exists to prevent, and it is one character wide.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeObsidianPublish, parsePublishConfig } from '../src/core/publishconfig.ts'

/** Read off a live vault, verbatim. */
const REAL_FILE = JSON.stringify({
  siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad',
  host: 'publish-01.obsidian.md',
  included: [
    'Wisdom & Approaches',
    'About',
    'Privacy',
    'WP Statistics',
    'Recommended',
    'Notes',
    'Team Productivity',
    'Personal Productivity',
  ],
  excluded: [],
})

const parse = (value) => parsePublishConfig(typeof value === 'string' ? value : JSON.stringify(value))

function config(value) {
  const result = parse(value)
  assert.equal(result.ok, true, 'expected a readable Publish configuration')
  return result.config
}

test('the real file, read as it stands', () => {
  const result = parse(REAL_FILE)
  assert.equal(result.ok, true)
  assert.deepEqual(result.config.included, [
    'Wisdom & Approaches',
    'About',
    'Privacy',
    'WP Statistics',
    'Recommended',
    'Notes',
    'Team Productivity',
    'Personal Productivity',
  ])
  assert.deepEqual(result.config.excluded, [])
  assert.equal(result.config.hasFilters, true)
  assert.deepEqual(result.dropped, [])
})

test('siteId and host are read as evidence, and nothing else is carried', () => {
  const parsed = config(REAL_FILE)
  assert.equal(parsed.siteId, 'e06fc8eb0e577dd6b3e0c6295c8602ad')
  assert.equal(parsed.host, 'publish-01.obsidian.md')
  // The shape is the guarantee: there is nowhere for a stray key to be kept,
  // and `host` in particular must never reach `builder.siteUrl`.
  assert.deepEqual(Object.keys(parsed).sort(), ['excluded', 'hasFilters', 'host', 'included', 'siteId'])
})

test('the older format, which had no filter keys at all', () => {
  const parsed = config({ siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad', host: 'publish-01.obsidian.md' })
  assert.equal(parsed.hasFilters, false, 'a real state, not a hypothetical: an older Publish wrote neither key')
  assert.deepEqual(parsed.included, [])
  assert.deepEqual(parsed.excluded, [])
})

test('filters present but empty is not the same as no filters', () => {
  const parsed = config({ siteId: 'abc', included: [], excluded: [] })
  assert.equal(parsed.hasFilters, true, 'this site answers "nothing by folder", which is an answer')
})

test('a blank entry is dropped, because one blank rule publishes the whole vault', () => {
  const parsed = parse({ siteId: 'abc', included: ['Notes', ''] })
  assert.deepEqual(parsed.config.included, ['Notes'])
  assert.deepEqual(parsed.dropped, [{ list: 'included', raw: '', reason: 'blank' }])
})

test('"/" and whitespace normalise to blank, and are caught by the same rule', () => {
  for (const entry of ['/', '   ', '///', ' / ']) {
    const parsed = parse({ siteId: 'abc', included: [entry, 'Notes'] })
    assert.deepEqual(parsed.config.included, ['Notes'], `"${entry}" must not survive`)
    assert.equal(parsed.dropped[0].reason, 'blank')
  }
})

test('a dot-folder entry is dropped: nothing inside one can ever publish', () => {
  const parsed = parse({ siteId: 'abc', included: ['.obsidian', 'Notes/.hidden', 'Notes'] })
  assert.deepEqual(parsed.config.included, ['Notes'])
  assert.deepEqual(
    parsed.dropped.map((entry) => entry.reason),
    ['always-excluded', 'always-excluded'],
  )
})

test('non-strings are dropped rather than coerced', () => {
  const parsed = parse({ siteId: 'abc', included: ['Notes', 42, null, { path: 'Ideas' }] })
  assert.deepEqual(parsed.config.included, ['Notes'])
  assert.deepEqual(
    parsed.dropped.map((entry) => entry.reason),
    ['not-a-string', 'not-a-string', 'not-a-string'],
  )
})

test('duplicates drop, first occurrence wins, and the order is otherwise preserved', () => {
  const parsed = parse({ siteId: 'abc', included: ['Notes', 'Ideas', '/Notes/', 'Archive'] })
  assert.deepEqual(parsed.config.included, ['Notes', 'Ideas', 'Archive'])
  assert.deepEqual(parsed.dropped, [{ list: 'included', raw: '/Notes/', reason: 'duplicate' }])
})

test('slashes are stripped and everything else survives verbatim', () => {
  const parsed = config({ siteId: 'abc', included: ['/Notes/', 'Wisdom & Approaches', 'Notes/Drafts'] })
  assert.deepEqual(parsed.included, ['Notes', 'Wisdom & Approaches', 'Notes/Drafts'])
})

test('excludes are read the same way, and reported against their own list', () => {
  const parsed = parse({ siteId: 'abc', included: ['Notes'], excluded: ['', 'Notes/Drafts'] })
  assert.deepEqual(parsed.config.excluded, ['Notes/Drafts'])
  assert.deepEqual(parsed.dropped, [{ list: 'excluded', raw: '', reason: 'blank' }])
})

test('an object with none of the known keys is not a Publish configuration', () => {
  const result = parse({ theme: 'moonstone' })
  assert.deepEqual(result, { ok: false, reason: 'not-publish-config' })
  assert.deepEqual(parse({}), { ok: false, reason: 'not-publish-config' })
})

test('malformed JSON, an array, null and a bare string are unreadable, and none of them throws', () => {
  for (const raw of ['{not json', '[]', '["Notes"]', 'null', '"Notes"', '42', '']) {
    assert.deepEqual(parsePublishConfig(raw), { ok: false, reason: 'unreadable' }, `for ${JSON.stringify(raw)}`)
  }
})

test('looksLikeObsidianPublish recognises the real pair, and neither half alone is required', () => {
  assert.equal(looksLikeObsidianPublish(config(REAL_FILE)), true)
  assert.equal(looksLikeObsidianPublish(config({ siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad' })), true)
  assert.equal(looksLikeObsidianPublish(config({ host: 'publish-07.obsidian.md' })), true, 'shard naming can change')
})

test('a hand-made file is not mistaken for a Publish site', () => {
  assert.equal(looksLikeObsidianPublish(config({ included: ['Notes'] })), false)
  assert.equal(looksLikeObsidianPublish(config({ siteId: 'my-site', host: 'notes.example.com' })), false)
  // A false negative costs one pre-ticked checkbox and nothing else, which is
  // why this is allowed to be loose in exactly this direction.
  assert.equal(looksLikeObsidianPublish(config({ siteId: 'e06fc8eb' })), false, 'too short to be a site id')
})
