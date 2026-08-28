import test from 'node:test'
import assert from 'node:assert/strict'
import {
  slugForPath,
  slugifySegment,
  findSlugCollisions,
  legacyUrlsFor,
  obsidianPublishUrl,
} from '../src/core/slug.ts'

/** What a static host does to a request path before it looks for a file. */
const decodePath = (url) => url.split('/').map(decodeURIComponent).join('/')

test('markdown loses its extension, assets keep theirs', () => {
  assert.equal(slugForPath('Notes/Zettelkasten.md'), 'notes/zettelkasten')
  assert.equal(slugForPath('Attachments/My Diagram (v2).PNG'), 'attachments/my-diagram-v2.png')
})

test('latin diacritics fold and apostrophes disappear', () => {
  assert.equal(slugForPath("Café/Naïve résumé.md"), 'cafe/naive-resume')
  assert.equal(slugifySegment("Don't Panic"), 'dont-panic')
})

test('cyrillic is transliterated', () => {
  assert.equal(slugForPath('Заметки/Лухман.md'), 'zametki/luhman')
})

test('scripts we cannot transliterate stay readable rather than becoming a hash', () => {
  assert.equal(slugForPath('日本語/ノート.md'), '日本語/ノート')
})

test('a name made only of emoji still gets a stable, unique slug', () => {
  const first = slugForPath('Notes/🎉.md')
  assert.equal(first, slugForPath('Notes/🎉.md'), 'stable across calls')
  assert.notEqual(first, slugForPath('Notes/🎈.md'), 'distinct inputs stay distinct')
  assert.match(first, /^notes\/untitled-/)
})

test('permalink frontmatter wins', () => {
  assert.equal(slugForPath('Notes/Whatever.md', { permalink: '/My Custom/Path/' }), 'my-custom/path')
  assert.equal(slugForPath('Notes/Whatever.md', { permalink: '   ' }), 'notes/whatever', 'blank falls back')
})

test('unicode normalisation forms collapse to the same slug', () => {
  // macOS hands out NFD, most other systems NFC. Same file, same URL.
  assert.equal(slugForPath('Notes/café.md'), slugForPath('Notes/café.md'))
})

test('case-only differences are reported as collisions', () => {
  const collisions = findSlugCollisions(
    new Map([
      ['Note.md', slugForPath('Note.md')],
      ['note.md', slugForPath('note.md')],
      ['other.md', slugForPath('other.md')],
    ]),
  )
  assert.equal(collisions.length, 1)
  assert.deepEqual(collisions[0].paths, ['Note.md', 'note.md'])
})

test('separators collapse instead of producing empty segments', () => {
  assert.equal(slugForPath('A  --  B/C___D.md'), 'a-b/c-d')
})

test('the old Obsidian Publish URL, as the path a host decodes it to', () => {
  // Both of these are confirmed against live sites: Obsidian's own help vault
  // serves Company/About us.md at /Company/About+us, and navidk.com serves
  // Wisdom & Approaches/Critical Thinking.md at
  // /Wisdom+%26+Approaches/Critical+Thinking. Asserting through decodePath is
  // the point rather than a convenience: the file has to sit where the host
  // looks after decoding, which is one substitution away from the vault path.
  assert.equal(obsidianPublishUrl('Company/About us.md'), decodePath('Company/About+us'))
  assert.equal(
    obsidianPublishUrl('Wisdom & Approaches/Critical Thinking.md'),
    decodePath('Wisdom+%26+Approaches/Critical+Thinking'),
  )
})

test('every other character survives, at any depth', () => {
  assert.equal(obsidianPublishUrl('یادداشت‌ها/تفکر نقاد.md'), 'یادداشت‌ها/تفکر+نقاد')
  assert.equal(obsidianPublishUrl('A/B/C/Deep Note.md'), 'A/B/C/Deep+Note')
  assert.equal(obsidianPublishUrl("Notes/Don't Panic.md"), "Notes/Don't+Panic")
  assert.equal(obsidianPublishUrl('Notes/🎉.md'), 'Notes/🎉')
})

test('an attachment keeps the extension a browser needs, a note loses .md', () => {
  assert.equal(obsidianPublishUrl('Attachments/Dia gram.PNG'), 'Attachments/Dia+gram.PNG')
  assert.equal(obsidianPublishUrl('Notes/Plain.md'), 'Notes/Plain')
})

test('old URLs are only recorded when they are asked for and would differ', () => {
  const differs = 'Company/About us.md'
  assert.deepEqual(legacyUrlsFor(differs, 'company/about-us', 'clean-with-redirects'), ['Company/About+us'])
  assert.equal(legacyUrlsFor(differs, 'company/about-us', 'clean'), undefined, 'off by default')
  assert.equal(
    legacyUrlsFor('notes/plain.md', 'notes/plain', 'clean-with-redirects'),
    undefined,
    'a note already at its old address needs no second page',
  )
  assert.deepEqual(
    legacyUrlsFor('Notes/Plain.md', 'notes/plain', 'clean-with-redirects'),
    ['Notes/Plain'],
    'case alone still differs on the Linux machine that builds the site',
  )
})

test('the note that becomes the homepage keeps its own old address', () => {
  // The scanner gives it the slug `index`; Obsidian served it at /Home, and
  // that URL has to end up at the site root rather than at /index.
  assert.deepEqual(legacyUrlsFor('Home.md', 'index', 'clean-with-redirects'), ['Home'])
})
