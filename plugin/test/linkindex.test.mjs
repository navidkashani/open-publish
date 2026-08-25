import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLinkIndex, expandEmbeds, splitSubpath, isExternalLink, noteMetadata } from '../src/core/linkindex.ts'

/** A stub of the slice of metadataCache the module uses. */
function makeResolver(vault) {
  return {
    getCache: (path) => vault[path]?.cache ?? null,
    getFirstLinkpathDest: (linkpath, _source) => {
      // Obsidian matches on the shortest unique path; basename match is enough here.
      const match = Object.keys(vault).find(
        (p) => p === linkpath || p === `${linkpath}.md` || p.endsWith(`/${linkpath}.md`) || p.endsWith(`/${linkpath}`),
      )
      return match ? { path: match, extension: match.split('.').pop() } : null
    },
  }
}

const vault = {
  'Notes/Home.md': { cache: { links: [{ link: 'Luhmann' }, { link: 'Private Log' }, { link: 'Nothing' }], embeds: [{ link: 'diagram.png' }] } },
  'Notes/Luhmann.md': { cache: { embeds: [{ link: 'portrait.jpg' }], links: [] } },
  'Journal/Private Log.md': { cache: {} },
  'attachments/diagram.png': { cache: null },
  'attachments/portrait.jpg': { cache: null },
  'attachments/unused.png': { cache: null },
}

test('splits subpaths and spots external links', () => {
  assert.deepEqual(splitSubpath('Note#Heading'), { linkpath: 'Note', subpath: '#Heading' })
  assert.deepEqual(splitSubpath('Note'), { linkpath: 'Note' })
  assert.deepEqual(splitSubpath('#Local'), { linkpath: '', subpath: '#Local' })
  assert.ok(isExternalLink('https://example.com') && isExternalLink('mailto:a@b.c') && isExternalLink('//cdn.example'))
  assert.ok(!isExternalLink('Notes/Thing'))
})

test('embedded attachments outside the published folders are pulled in automatically', () => {
  const included = expandEmbeds(makeResolver(vault), ['Notes/Home.md'], {
    isSupported: (path) => path in vault,
    isBlocked: () => false,
  })
  assert.ok(included.has('attachments/diagram.png'), 'the image a published note embeds must ship with it')
  assert.ok(!included.has('attachments/unused.png'), 'unrelated attachments are left alone')
})

test('embed expansion is transitive through embedded notes', () => {
  const included = expandEmbeds(
    makeResolver({ ...vault, 'Notes/Home.md': { cache: { embeds: [{ link: 'Luhmann' }], links: [] } } }),
    ['Notes/Home.md'],
    { isSupported: (path) => path in vault, isBlocked: () => false },
  )
  assert.ok(included.has('Notes/Luhmann.md'))
  assert.ok(included.has('attachments/portrait.jpg'), "the embedded note's own embed comes too")
})

test('an explicit publish: false is never overridden by auto-inclusion', () => {
  const included = expandEmbeds(makeResolver(vault), ['Notes/Home.md'], {
    isSupported: (path) => path in vault,
    isBlocked: (path) => path === 'attachments/diagram.png',
  })
  assert.ok(!included.has('attachments/diagram.png'), 'a user decision outranks a convenience feature')
})

test('an embed cycle terminates', () => {
  const cyclic = {
    'A.md': { cache: { embeds: [{ link: 'B' }], links: [] } },
    'B.md': { cache: { embeds: [{ link: 'A' }], links: [] } },
  }
  const included = expandEmbeds(makeResolver(cyclic), ['A.md'], { isSupported: (p) => p in cyclic, isBlocked: () => false })
  assert.deepEqual([...included].sort(), ['A.md', 'B.md'])
})

test('links are classified as published, unpublished, or unresolved', () => {
  const published = new Set(['Notes/Home.md', 'Notes/Luhmann.md', 'attachments/diagram.png'])
  const slugs = new Map([
    ['Notes/Luhmann.md', 'notes/luhmann'],
    ['attachments/diagram.png', 'attachments/diagram.png'],
  ])
  const index = buildLinkIndex(makeResolver(vault), published, slugs)
  const home = index['Notes/Home.md']

  const byRaw = Object.fromEntries(home.map((entry) => [entry.raw, entry]))
  assert.deepEqual(byRaw['Luhmann'], { raw: 'Luhmann', target: 'Notes/Luhmann.md', status: 'published', slug: 'notes/luhmann' })
  assert.equal(byRaw['Private Log'].status, 'unpublished', 'resolves, but was not published')
  assert.equal(byRaw['Private Log'].slug, undefined)
  assert.equal(byRaw['Nothing'].status, 'unresolved')
  assert.equal(byRaw['Nothing'].target, null)
  assert.equal(byRaw['diagram.png'].embed, true)
})

test('a link written twice is recorded once', () => {
  const doubled = { 'A.md': { cache: { links: [{ link: 'B' }, { link: 'B' }], embeds: [{ link: 'B' }] } }, 'B.md': { cache: {} } }
  const index = buildLinkIndex(makeResolver(doubled), new Set(['A.md', 'B.md']), new Map([['B.md', 'b']]))
  assert.equal(index['A.md'].length, 1)
  assert.equal(index['A.md'][0].embed, true, 'but an embed occurrence is still recorded')
})

test('external links and same-note anchors are not indexed', () => {
  const v = { 'A.md': { cache: { links: [{ link: 'https://example.com' }, { link: '#Section' }], embeds: [] } } }
  const index = buildLinkIndex(makeResolver(v), new Set(['A.md']), new Map())
  assert.equal(index['A.md'], undefined)
})

test('subpaths and aliases are preserved for the generator', () => {
  const v = { 'A.md': { cache: { links: [{ link: 'B#Ideas', displayText: 'those ideas' }], embeds: [] } }, 'B.md': { cache: {} } }
  const index = buildLinkIndex(makeResolver(v), new Set(['A.md', 'B.md']), new Map([['B.md', 'b']]))
  assert.equal(index['A.md'][0].subpath, '#Ideas')
  assert.equal(index['A.md'][0].display, 'those ideas')
  assert.equal(index['A.md'][0].slug, 'b')
})

test('title falls back from frontmatter to heading to filename', () => {
  const v = {
    'a.md': { cache: { frontmatter: { title: 'From frontmatter' } } },
    'b.md': { cache: { headings: [{ heading: 'From heading', level: 1 }] } },
    'Folder/c.md': { cache: {} },
    'd.md': { cache: { frontmatter: { aliases: ['One', 'Two'] } } },
    'e.md': { cache: { frontmatter: { alias: 'Single' } } },
  }
  const resolver = makeResolver(v)
  assert.equal(noteMetadata(resolver, 'a.md').title, 'From frontmatter')
  assert.equal(noteMetadata(resolver, 'b.md').title, 'From heading')
  assert.equal(noteMetadata(resolver, 'Folder/c.md').title, 'c')
  assert.deepEqual(noteMetadata(resolver, 'd.md').aliases, ['One', 'Two'])
  assert.deepEqual(noteMetadata(resolver, 'e.md').aliases, ['Single'])
  assert.equal(noteMetadata(resolver, 'a.md').aliases, undefined)
})
