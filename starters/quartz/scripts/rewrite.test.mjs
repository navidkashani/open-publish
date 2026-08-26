import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteLinks, protectedRanges, anchorFor } from './lib/rewrite.mjs'

const links = [
  { raw: 'Luhmann', target: 'Notes/Luhmann.md', status: 'published', slug: 'notes/luhmann' },
  { raw: 'Private Log', target: 'Journal/Private Log.md', status: 'unpublished' },
  { raw: 'Nothing', target: null, status: 'unresolved' },
  { raw: 'diagram.png', target: 'attachments/diagram.png', status: 'published', slug: 'attachments/diagram.png', embed: true },
  { raw: 'Luhmann#Ideas', target: 'Notes/Luhmann.md', status: 'published', slug: 'notes/luhmann', subpath: '#Ideas' },
  { raw: 'Secret.png', target: 'attachments/Secret.png', status: 'unpublished', embed: true },
]

test('a published wikilink becomes a site link', () => {
  assert.equal(rewriteLinks('See [[Luhmann]] today.', links), 'See [Luhmann](/notes/luhmann) today.')
})

test('an alias is preserved as the link text', () => {
  assert.equal(rewriteLinks('See [[Luhmann|the man]].', links), 'See [the man](/notes/luhmann).')
})

test('a link to an unpublished note renders as plain text, not a 404', () => {
  assert.equal(rewriteLinks('See [[Private Log]].', links), 'See Private Log.')
  assert.equal(rewriteLinks('See [[Private Log|my journal]].', links), 'See my journal.')
})

test('an unresolved link renders as plain text', () => {
  assert.equal(rewriteLinks('See [[Nothing]].', links), 'See Nothing.')
})

test('a link with no index entry at all still degrades to plain text', () => {
  assert.equal(rewriteLinks('See [[Never Indexed]].', links), 'See Never Indexed.')
})

test('an embedded image becomes a real image reference', () => {
  assert.equal(rewriteLinks('![[diagram.png]]', links), '![](/attachments/diagram.png)')
})

test('an embedded image that was not published disappears rather than breaking', () => {
  assert.equal(rewriteLinks('![[Secret.png]]', links), 'Secret.png')
})

test('a transcluded note stays a wikilink so the generator can inline it', () => {
  assert.equal(rewriteLinks('![[Luhmann]]', links), '![[notes/luhmann]]')
})

test('heading subpaths become URL anchors', () => {
  assert.equal(rewriteLinks('See [[Luhmann#Ideas]].', links), 'See [Luhmann > Ideas](/notes/luhmann#ideas).')
  assert.equal(anchorFor('#Some Long Heading!'), '#some-long-heading')
  assert.equal(anchorFor('#^block-ref'), '', 'block refs have no stable anchor')
})

test('markdown-style links are rewritten too, including percent-encoding', () => {
  const md = [{ raw: 'Notes/My Note.md', target: 'Notes/My Note.md', status: 'published', slug: 'notes/my-note' }]
  assert.equal(rewriteLinks('[label](Notes/My%20Note.md)', md), '[label](/notes/my-note)')
})

test('external links and absolute paths are left alone', () => {
  const text = '[site](https://example.com) and [root](/already/absolute) and [anchor](#section)'
  assert.equal(rewriteLinks(text, links), text)
})

test('links inside fenced code blocks survive verbatim', () => {
  const text = 'Before [[Luhmann]]\n\n```\n[[Luhmann]] stays\n```\n\nAfter [[Luhmann]]'
  const out = rewriteLinks(text, links)
  assert.ok(out.includes('[[Luhmann]] stays'), 'the fenced example is untouched')
  assert.equal(out.match(/\[Luhmann\]\(\/notes\/luhmann\)/g).length, 2)
})

test('tilde fences and nested backtick fences are handled', () => {
  const text = '~~~\n[[Luhmann]]\n~~~\n\n````md\n```\n[[Luhmann]]\n```\n````'
  assert.equal(rewriteLinks(text, links), text)
})

test('links inside inline code survive verbatim', () => {
  assert.equal(rewriteLinks('Type `[[Luhmann]]` to link.', links), 'Type `[[Luhmann]]` to link.')
  assert.equal(rewriteLinks('``a `[[Luhmann]]` b``', links), '``a `[[Luhmann]]` b``')
})

test('frontmatter is never rewritten', () => {
  const text = '---\naliases:\n  - "[[Luhmann]]"\n---\n\nBody [[Luhmann]]'
  const out = rewriteLinks(text, links)
  assert.ok(out.startsWith('---\naliases:\n  - "[[Luhmann]]"\n---'))
  assert.ok(out.endsWith('Body [Luhmann](/notes/luhmann)'))
})

test('a same-note anchor is left for the generator', () => {
  assert.equal(rewriteLinks('Jump to [[#Section]].', links), 'Jump to [[#Section]].')
})

test('a site root prefix is applied to every generated URL', () => {
  assert.equal(rewriteLinks('[[Luhmann]]', links, { siteRoot: '/notes' }), '[Luhmann](/notes/notes/luhmann)')
})

test('protected ranges cover frontmatter, fences and code spans', () => {
  const ranges = protectedRanges('---\na: 1\n---\ntext `code` more\n```\nfence\n```\n')
  assert.ok(ranges.length >= 3)
})

test('a note with no links is returned unchanged', () => {
  const text = 'Just prose, with a [markdown](https://example.com) link.'
  assert.equal(rewriteLinks(text, []), text)
})

test('a code block is still protected after an earlier link changed length', () => {
  // protectedRanges is measured against the original text, but the markdown-link
  // pass runs over the *output* of the wikilink pass. Rewriting a wikilink
  // shifts every offset after it, so ranges computed once no longer line up,
  // and a link inside a code fence gets rewritten as if it were prose.
  const links = [
    { raw: 'N', target: 'Notes/N.md', status: 'published', slug: 'notes/a-deliberately-long-slug-to-shift-offsets' },
    { raw: 't.md', target: 'Notes/t.md', status: 'published', slug: 'notes/t' },
  ]
  const text = ['[[N]]', '', '```markdown', '[x](t.md)', '```'].join('\n')

  const out = rewriteLinks(text, links, {})
  assert.match(out, /\[N\]\(\/notes\/a-deliberately-long-slug-to-shift-offsets\)/, 'the prose link is rewritten')
  assert.match(out, /\[x\]\(t\.md\)/, 'and the one inside the fence is left exactly as written')
})
