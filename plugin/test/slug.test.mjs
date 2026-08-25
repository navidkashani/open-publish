import test from 'node:test'
import assert from 'node:assert/strict'
import { slugForPath, slugifySegment, findSlugCollisions } from '../src/core/slug.ts'

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
