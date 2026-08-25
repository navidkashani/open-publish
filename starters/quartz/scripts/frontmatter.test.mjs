import test from 'node:test'
import assert from 'node:assert/strict'
import { applyNoteMetadata } from './lib/frontmatter.mjs'

test('adds frontmatter to a note that has none', () => {
  assert.equal(
    applyNoteMetadata('# Hello\n\nBody.\n', { title: 'Hello' }),
    '---\ntitle: "Hello"\n---\n\n# Hello\n\nBody.\n',
  )
})

test('inserts a title into existing frontmatter without disturbing it', () => {
  const out = applyNoteMetadata('---\npublish: true\ntags: [a]\n---\n\n# Zettelkasten\n', { title: 'Zettelkasten' })
  assert.equal(out, '---\npublish: true\ntags: [a]\ntitle: "Zettelkasten"\n---\n\n# Zettelkasten\n')
})

test("an author's own title always wins", () => {
  const text = '---\ntitle: My Own Title\n---\n\nBody\n'
  assert.equal(applyNoteMetadata(text, { title: 'Derived' }), text)
})

test('aliases become frontmatter so the generator can emit redirects for them', () => {
  const out = applyNoteMetadata('---\npublish: true\n---\n\nBody\n', { title: 'T', aliases: ['Zettel', 'Slip box'] })
  assert.match(out, /aliases: \["Zettel", "Slip box"\]/)
})

test('existing aliases, in either spelling, are left alone', () => {
  for (const key of ['aliases', 'alias']) {
    const text = `---\n${key}: [Mine]\n---\n\nBody\n`
    assert.match(applyNoteMetadata(text, { aliases: ['Other'] }), new RegExp(`${key}: \\[Mine\\]`))
    assert.doesNotMatch(applyNoteMetadata(text, { aliases: ['Other'] }), /Other/)
  }
})

test('quotes and colons in a title cannot break the YAML', () => {
  const out = applyNoteMetadata('Body\n', { title: 'He said "hi": really' })
  assert.equal(out.split('\n')[1], 'title: "He said \\"hi\\": really"')
})

test('unterminated frontmatter is left untouched rather than guessed at', () => {
  const text = '---\ntitle: broken\n\nno closing marker\n'
  assert.equal(applyNoteMetadata(text, { title: 'X' }), text)
})

test('nothing to add means the file is returned unchanged', () => {
  assert.equal(applyNoteMetadata('Body\n', {}), 'Body\n')
  assert.equal(applyNoteMetadata('---\na: 1\n---\nBody\n', {}), '---\na: 1\n---\nBody\n')
})

test('a --- separator in the body is not mistaken for frontmatter', () => {
  const out = applyNoteMetadata('Body\n\n---\n\nMore\n', { title: 'T' })
  assert.ok(out.startsWith('---\ntitle: "T"\n---\n\nBody'))
})
