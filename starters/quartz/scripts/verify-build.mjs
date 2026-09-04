#!/usr/bin/env node
/**
 * End-to-end verification of the whole build half, with no cloud account.
 *
 * Stands up a fake bucket holding a small snapshot, runs the three real build
 * scripts against it, and asserts on the HTML that comes out, including the
 * things only a real generator can tell you: that a published link becomes an
 * <a>, that an unpublished one does NOT, and that a wikilink inside a code
 * fence survives verbatim.
 *
 * Needs network the first time, to fetch Quartz.
 *
 *   npm run verify
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, cp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const STARTER = join(import.meta.dirname, '..')
const WORK = join(tmpdir(), `op-verify-${process.pid}`)
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

const files = {
  // The homepage also carries an old URL, because its slug is `index` and that
  // is the one old address which must land on `/` rather than on `/index`.
  'Notes/Home.md': {
    content: '---\ntitle: Home\n---\n\n# Welcome\n\nStart at [[Zettelkasten]].\n',
    slug: 'index',
    legacyUrls: ['Notes/Home'],
  },
  // The migration case, with the two things Quartz mangles if an old URL is
  // shipped as an alias: a capital and an `&`.
  'Wisdom & Approaches/Critical Thinking.md': {
    content: '# Critical Thinking\n\nA note that used to live somewhere else.\n',
    slug: 'wisdom-approaches/critical-thinking',
    legacyUrls: ['Wisdom+&+Approaches/Critical+Thinking'],
  },
  'Notes/Zettelkasten.md': {
    content: '# Zettelkasten\n\nInvented by [[Luhmann]].\nA second line after a single newline.\n\nSee also [[Private Log]] and [[Nothing]].\n\n![[diagram.png]]\n\n```\n[[Luhmann]] in code stays literal\n```\n',
    slug: 'notes/zettelkasten',
  },
  'Notes/Luhmann.md': { content: '# Luhmann\n\nA sociologist.\n', slug: 'notes/luhmann' },
  'attachments/diagram.png': { content: 'FAKE-PNG-BYTES', slug: 'attachments/diagram.png' },
}
const links = {
  'Notes/Home.md': [{ raw: 'Zettelkasten', target: 'Notes/Zettelkasten.md', status: 'published', slug: 'notes/zettelkasten' }],
  'Notes/Zettelkasten.md': [
    { raw: 'Luhmann', target: 'Notes/Luhmann.md', status: 'published', slug: 'notes/luhmann' },
    { raw: 'Private Log', target: 'Journal/Private Log.md', status: 'unpublished' },
    { raw: 'Nothing', target: null, status: 'unresolved' },
    { raw: 'diagram.png', target: 'attachments/diagram.png', status: 'published', slug: 'attachments/diagram.png', embed: true },
  ],
}

const objects = new Map()
const snapFiles = {}
for (const [path, { content, slug, legacyUrls }] of Object.entries(files)) {
  const buf = Buffer.from(content)
  const h = sha256(buf)
  snapFiles[path] = { hash: h, size: buf.length, mtime: 1, slug, ...(legacyUrls ? { legacyUrls } : {}) }
  objects.set(`objects/${h.slice(0, 2)}/${h}`, buf)
}
const snapshot = {
  version: 1, id: '2026-08-25T09-00-00Z-abc123', parent: null, createdAt: Date.now(),
  generator: { plugin: 'open-publish', version: '0.1.0' },
  site: {
    title: 'Verification Site',
    homepage: 'Notes/Home.md',
    // Persian, so the one thing a build can prove about a language option gets
    // proved: that the tag reaches `<html>` and that the direction derived from
    // it reaches the layout. Every other check below is on markup and class
    // names, so none of them care what language the chrome is in.
    locale: 'fa-IR',
    dir: 'rtl',
    noIndex: true,
    showThemeToggle: false,
    strictLineBreaks: false,
    // On, so the arrangement below has something to arrange. The "an option
    // switched off removes its component" case is covered by
    // `showThemeToggle` a line down, which is the same mechanism.
    showNavigation: true,
    showSearch: true,
    showGraph: true,
    showOutline: true,
    showBacklinks: true,
    showTags: true,
    // On, against the default, so the assertion below is about the option
    // rather than about Quartz's own layout: `ContentMeta` is what Quartz
    // renders here, and off is the state a fresh install is already in.
    showPageMetadata: true,
    showPrevNext: false,
    // Off, so the one thing only a real build can show about this option gets
    // shown: Quartz emits the popover script into its bundle rather than into
    // the page, so nothing in the HTML says whether it was dropped.
    showHoverPreview: false,
    analytics: { provider: 'google', id: 'G-VERIFY123' },
    // A reordered root and a hidden folder. `wisdom-approaches/index` is the
    // detail this whole run exists to check: a folder has no page of its own in
    // this vault, and Quartz still names its node after an index page it does
    // not have.
    //
    // `index` is the homepage, which the manager lists as a root row because
    // some generators draw one. Quartz does not: its trie keeps the homepage as
    // the root node's own data and never as a child, so this entry is compared
    // with nothing. That it is *inert* rather than merely unused is what the
    // checks below are for, and this is the only build that can show it.
    nav: {
      order: ['index', 'notes/index', 'wisdom-approaches/index'],
      hidden: ['wisdom-approaches/index'],
    },
    // What the vault calls these folders. `wisdom-approaches` is the address,
    // and it is all Quartz can print on its own: a folder has no file to carry
    // a title, so the trie falls back to the slug segment. The ampersand and
    // the spaces are the point, being exactly what cannot survive a slug.
    folders: {
      'wisdom-approaches/index': 'Wisdom & Approaches',
      'notes/index': 'Notes',
    },
  },
  files: snapFiles, links, redirects: [{ from: 'notes/old-name', to: 'notes/zettelkasten' }],
}
objects.set(`snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot)))
objects.set('current.json', Buffer.from(JSON.stringify({ version: 1, snapshot: snapshot.id, updatedAt: Date.now() })))

const server = createServer((req, res) => {
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/vault\//, ''))
  const body = objects.get(key)
  if (!body) { res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>'); return }
  res.writeHead(200, { 'Content-Length': body.length }); res.end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

await mkdir(WORK, { recursive: true })
for (const f of ['scripts', 'quartz.config.ts', 'quartz.layout.ts', 'op-site.ts', 'nav-sort.ts', 'package.json', 'styles']) {
  await cp(join(STARTER, f), join(WORK, f), { recursive: true })
}
// Reuse a Quartz checkout if one is already here, so repeat runs are fast.
const cached = join(STARTER, '.quartz')
if (await readdir(cached).then(() => true, () => false)) {
  await cp(cached, join(WORK, '.quartz'), { recursive: true })
}

const env = {
  ...process.env,
  OP_ENDPOINT: `http://127.0.0.1:${port}`, OP_BUCKET: 'vault', OP_REGION: 'auto',
  OP_ACCESS_KEY_ID: 'key', OP_SECRET_ACCESS_KEY: 'secret',
  OP_SITE_URL: 'https://verify.example',
}
const run = (script) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(WORK, 'scripts', script)], { cwd: WORK, env, stdio: 'inherit' })
  c.on('exit', resolve)
})

console.log('\n===== fetch-content =====')
if (await run('fetch-content.mjs')) { server.close(); process.exit(1) }
console.log('\n===== build-site (real Quartz) =====')
if (await run('build-site.mjs')) { server.close(); process.exit(1) }
console.log('\n===== finalize =====')
if (await run('finalize.mjs')) { server.close(); process.exit(1) }
server.close()

console.log('\n===== RESULTS =====')
let failures = 0
const out = await readdir(join(WORK, 'public'), { recursive: true })
console.log('output files:', out.filter((f) => !f.includes('/')).slice(0, 20).join(', '))
const html = await readFile(join(WORK, 'public/notes/zettelkasten.html'), 'utf8')
const check = (label, ok) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
check('published link is an <a>', /href="[^"]*notes\/luhmann"/.test(html))
check('unpublished link is plain text, no <a>', html.includes('Private Log') && !/href="[^"]*private/i.test(html))
check('unresolved link is plain text', html.includes('Nothing') && !/href="[^"]*nothing/i.test(html))
check('embedded image rendered', /<img[^>]+attachments\/diagram\.png/.test(html))
check('code fence kept literal [[Luhmann]]', html.includes('[[Luhmann]] in code stays literal'))
// Also the other half of "inert": the navigation order names `index`, and an
// entry naming the homepage must not be able to take the homepage away.
check('index page built from Home.md', out.includes('index.html'))
check('asset copied', out.some((f) => f.endsWith('diagram.png')))
const marker = JSON.parse(await readFile(join(WORK, 'public/_publish.json'), 'utf8'))
check(`marker snapshot matches (${marker.snapshot})`, marker.snapshot === snapshot.id)
check('_headers has no-store', (await readFile(join(WORK, 'public/_headers'), 'utf8')).includes('no-store'))
check('_redirects written', (await readFile(join(WORK, 'public/_redirects'), 'utf8')).includes('/notes/old-name /notes/zettelkasten 301'))
const home = await readFile(join(WORK, 'public/index.html'), 'utf8')
check('site title from snapshot', home.includes('Verification Site'))

// --- the old URLs a migrator arrives on still land on the page -------------
// This is the whole of the Obsidian Publish migration, and only a real build
// can show it: the file has to exist at the old path character for character,
// capitals and `&` intact. Shipped as an alias instead of a permalink, Quartz
// would have written `/Wisdom+-and-+Approaches/…` and every old link would 404.
const oldUrl = await readFile(join(WORK, 'public/Wisdom+&+Approaches/Critical+Thinking.html'), 'utf8').catch(
  () => '',
)
check('a page is served at the URL Obsidian Publish used', oldUrl.length > 0)
check('and it points at the note in its new home', /wisdom-approaches\/critical-thinking/.test(oldUrl))
check('search engines are told which one is canonical', /rel="canonical"/.test(oldUrl))
// The homepage is the one note whose old URL cannot simply point at its slug:
// its slug is `index`, and `/index` is a path the generator never emitted. From
// `/Notes/Home` the site root is `../`, and that is what it has to say.
const oldHome = await readFile(join(WORK, 'public/Notes/Home.html'), 'utf8').catch(() => '')
check('the old homepage URL goes to the site root, not to /index', /content="0; url=\.\.\/"/.test(oldHome))

// --- the site options actually take effect in the rendered HTML ---
check('showNavigation:true renders the page explorer', /class="[^"]*explorer/.test(home))
check('showThemeToggle:false removes the dark-mode control', !/class="[^"]*darkmode/.test(home))
check('showSearch:true keeps search', /class="[^"]*search/.test(home))
check('showGraph:true keeps the graph', /id="graph-container"|class="[^"]*graph/.test(html))
check('showBacklinks:true keeps backlinks', /backlink/i.test(html))
check('showPageMetadata:true keeps the page metadata block', /class="[^"]*content-meta/.test(html))
// `showPrevNext:false` is set in the snapshot above and there is no markup to
// assert it against: Quartz has no previous/next component, so this starter
// carries the intent and renders nothing for it. What can be checked is that it
// was carried rather than dropped as an option this starter does not know, which
// is the difference between "ignored on purpose" and "your plugin is too new".
const opSite = await readFile(join(WORK, 'op-site.ts'), 'utf8')
check('an option Quartz cannot render is still carried through', /"showPrevNext": false/.test(opSite))
// Quartz emits analytics into its script bundle, not inline in the HTML.
const scripts = await Promise.all(
  out.filter((f) => f.endsWith('.js')).map((f) => readFile(join(WORK, 'public', f), 'utf8')),
)
const bundled = scripts.join('\n')
// `active-popover` rather than `popover`: the class `popover-hint` is Quartz's
// own layout vocabulary and `search.inline.ts` reads it whether or not link
// previews exist, so the bare word is in the bundle of every site with search.
// This string is written by `popover.inline.ts` alone, which is the script
// `enablePopovers` actually gates.
check('showHoverPreview:false leaves the popover script out of the bundle', !bundled.includes('active-popover'))
// Left on in the snapshot above, so this is the other half of the same option:
// the title is a component that has to still be there when nobody turned it off.
check('showInlineTitle defaults on and keeps the article title', /class="[^"]*article-title/.test(html))
// And the page the option was never about. A folder listing has no note behind
// it, so `ArticleTitle` is the only thing naming it, which is why the list
// layout renders it unconditionally. Only a real build shows that Quartz emits
// such a page at all, and that it is the list layout that drew it.
const folderPage = await readFile(join(WORK, 'public/wisdom-approaches/index.html'), 'utf8')
check('a folder page is named by its title, which the option never governed', /class="[^"]*article-title/.test(folderPage))
check('analytics provider mapped to a real tag', bundled.includes('G-VERIFY123'))
check('analytics uses the right provider script', /googletagmanager|gtag/.test(bundled))
check('strictLineBreaks:false renders a single newline as a break', /<br\s*\/?>/.test(html))
check('noIndex:true writes robots.txt', (await readFile(join(WORK, 'public/robots.txt'), 'utf8')).includes('Disallow: /'))
check('noIndex:true adds the header rule', (await readFile(join(WORK, 'public/_headers'), 'utf8')).includes('X-Robots-Tag'))

// --- the language reaches the page, and the direction reaches the layout ----
// The reason `dir` is in the snapshot at all. Quartz has no direction concept
// of its own, so all three of these come from patches applied to its files, and
// a patch that silently stopped matching would show up here and nowhere else.
// `lang` is the primary subtag: Quartz renders `fa` from `fa-IR`, which is what
// upstream does with every locale and is still a correct BCP-47 tag.
check('the language reaches <html lang>', /<html lang="fa"/.test(html))
check('and the derived direction reaches it too', /<html [^>]*dir="rtl"/.test(html))
check('an English build would not be flipped', !/<html [^>]*dir="ltr"/.test(html))
const styles = await Promise.all(
  out.filter((f) => f.endsWith('.css')).map((f) => readFile(join(WORK, 'public', f), 'utf8')),
)
const css = styles.join('\n')
check('the right-to-left sheet is in the bundle', css.includes('[dir=rtl]') || css.includes("[dir='rtl']"))
check('and it mirrors the explorer indent guides', /\[dir=.?rtl.?\][^{]*folder-outer[^{]*\{[^}]*border-right/.test(css))

// --- the navigation arrangement survives the trip into the page ------------
// The one thing only a real build can show: Quartz serialises the comparator
// and the filter into an attribute with `.toString()` and rebuilds them in the
// browser with `new Function`. A closure passes every other test and dies here,
// silently, leaving the sidebar in some other order with no error anywhere.
const dataFns = /data-data-fns="([^"]*)"/.exec(home)
check('the explorer carries the functions the layout gave it', dataFns !== null)
if (dataFns) {
  const decoded = JSON.parse(dataFns[1].replace(/&#34;|&quot;/g, '"').replace(/&amp;/g, '&'))
  // Exactly what `quartz/components/scripts/explorer.inline.ts` does with it.
  const sortFn = new Function('return ' + decoded.sortFn)()
  const filterFn = new Function('return ' + decoded.filterFn)()
  const node = (slug, isFolder = false) => ({
    slug,
    slugSegment: slug.split('/').pop(),
    displayName: slug.split('/').pop(),
    isFolder,
  })
  const sorted = [node('attachments/index', true), node('wisdom-approaches/index', true), node('notes/index', true)]
    .sort(sortFn)
    .map((n) => n.slug)
  // The homepage's entry leads the order, so this also says that a rank nothing
  // matches costs the siblings underneath it nothing: ranks are read by slug and
  // never by position.
  check(
    'the rebuilt comparator puts the arranged folders first, in the arranged order',
    sorted[0] === 'notes/index' && sorted[1] === 'wisdom-approaches/index',
  )
  // The rename, which only a real build can show: `mapFn` makes the same trip
  // through `.toString()` as the other two, and Quartz runs it before the sort,
  // so a folder ends up sorted under the name a reader sees.
  const mapFn = new Function('return ' + decoded.mapFn)()
  const renamed = node('wisdom-approaches/index', true)
  mapFn(renamed)
  check('the rebuilt rename calls a folder what the vault calls it', renamed.displayName === 'Wisdom & Approaches')
  const untouched = node('attachments/index', true)
  mapFn(untouched)
  check('and leaves a folder it does not name alone', untouched.displayName === 'index')
  check('the rebuilt filter drops the hidden folder', filterFn(node('wisdom-approaches/index', true)) === false)
  check('and still drops the tag index, which is Quartz\'s own rule', filterFn(node('tags', true)) === false)
  check('and keeps everything else', filterFn(node('notes/index', true)) === true)
}
// Hidden is not private, and this is where that claim is actually tested. The
// folder above is out of the sidebar; every page in it is still built, still at
// its own address and still in the sitemap. docs/security.md says so in words,
// and this is the build that has to agree.
check(
  'a hidden folder is still published: its pages are still built',
  out.some((f) => f.startsWith('wisdom-approaches/') && f.endsWith('.html')),
)
check(
  'and still listed in the sitemap',
  (await readFile(join(WORK, 'public/sitemap.xml'), 'utf8')).includes('wisdom-approaches/critical-thinking'),
)

// The convention the whole scheme rests on, asserted against Quartz's source
// rather than inferred: a folder node names itself after an index page whether
// or not one exists. If upstream ever stops doing that, every folder in every
// arrangement silently stops matching, and this is the line that would say so.
const fileTrie = await readFile(join(WORK, '.quartz/quartz/util/fileTrie.ts'), 'utf8').catch(() => '')
check(
  'a folder node is still addressed as <folder>/index',
  /get slug\(\)[\s\S]*?if \(this\.isFolder\)[\s\S]*?joinSegments\(path, "index"\)/.test(fileTrie),
)

// Keep the Quartz checkout for next time; drop everything else.
await cp(join(WORK, '.quartz'), join(STARTER, '.quartz'), { recursive: true, force: true }).catch(() => {})
await rm(WORK, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed. The starter is ready to publish as a template repository.')
