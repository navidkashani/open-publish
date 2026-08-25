import test from 'node:test'
import assert from 'node:assert/strict'
import { getPublishFlag, parsePublishFrontmatter, matchesFolderRule, isSupportedFile } from '../src/core/selection.ts'

const rules = (overrides = {}) => ({ includes: [], excludes: [], explicit: {}, ...overrides })

test('frontmatter accepts booleans and the documented strings', () => {
  assert.equal(parsePublishFrontmatter(true), true)
  assert.equal(parsePublishFrontmatter(false), false)
  assert.equal(parsePublishFrontmatter('YES'), true)
  assert.equal(parsePublishFrontmatter(' true '), true)
  assert.equal(parsePublishFrontmatter('No'), false)
  assert.equal(parsePublishFrontmatter(1), true)
  assert.equal(parsePublishFrontmatter(0), false)
  // Obsidian Publish's `return !!n` publishes ANY other non-empty string.
  // We fall through to the folder rules instead: a typo must not publish a note.
  assert.equal(parsePublishFrontmatter('maybe'), null)
  assert.equal(parsePublishFrontmatter('draft'), null)
  assert.equal(parsePublishFrontmatter(undefined), null)
  assert.equal(parsePublishFrontmatter({}), null)
})

test('frontmatter beats every folder rule', () => {
  const r = rules({ excludes: ['Notes'], includes: ['Notes'] })
  assert.equal(getPublishFlag('Notes/a.md', true, r), true)
  assert.equal(getPublishFlag('Notes/b.md', false, r), false)
})

test('an explicit per-file choice beats folder rules but not frontmatter', () => {
  const r = rules({ excludes: ['Private'], explicit: { 'Private/a.md': true, 'Notes/b.md': false } })
  assert.equal(getPublishFlag('Private/a.md', undefined, r), true)
  assert.equal(getPublishFlag('Notes/b.md', undefined, r), false)
  assert.equal(getPublishFlag('Private/a.md', false, r), false, 'frontmatter still wins')
})

test('excludes are checked before includes', () => {
  const r = rules({ includes: ['Notes'], excludes: ['Notes/Drafts'] })
  assert.equal(getPublishFlag('Notes/ok.md', undefined, r), true)
  assert.equal(getPublishFlag('Notes/Drafts/wip.md', undefined, r), false)
})

test('unmatched files are offered, not published', () => {
  assert.equal(getPublishFlag('Elsewhere/a.md', undefined, rules()), null)
})

test('dot-folders are never publishable', () => {
  assert.equal(getPublishFlag('.obsidian/plugins/x/data.json', undefined, rules({ includes: [''] })), false)
  assert.equal(getPublishFlag('.trash/deleted.md', true, rules()), false, 'even with publish: true')
  assert.equal(getPublishFlag('Notes/.secret/a.md', true, rules()), false)
})

test('only supported extensions are candidates', () => {
  assert.ok(isSupportedFile('a.md') && isSupportedFile('a.PNG') && isSupportedFile('a.canvas'))
  assert.ok(!isSupportedFile('a.exe') && !isSupportedFile('a.docx') && !isSupportedFile('noext'))
  assert.equal(getPublishFlag('Notes/script.exe', true, rules()), false)
})

test('folder rules match on path boundaries, not string prefixes', () => {
  assert.ok(matchesFolderRule('Notes/a.md', 'Notes'))
  assert.ok(matchesFolderRule('Notes/a.md', '/Notes/'))
  assert.ok(!matchesFolderRule('Notebooks/a.md', 'Notes'), 'Notebooks must not match Notes')
  assert.ok(matchesFolderRule('anything.md', ''), 'an empty rule means the whole vault')
})
