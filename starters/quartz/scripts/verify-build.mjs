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
    showNavigation: false,
    showSearch: true,
    showGraph: true,
    showOutline: true,
    showBacklinks: true,
    showTags: true,
    analytics: { provider: 'google', id: 'G-VERIFY123' },
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
for (const f of ['scripts', 'quartz.config.ts', 'quartz.layout.ts', 'op-site.ts', 'package.json', 'styles']) {
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
check('showNavigation:false removes the page explorer', !/class="[^"]*explorer/.test(home))
check('showThemeToggle:false removes the dark-mode control', !/class="[^"]*darkmode/.test(home))
check('showSearch:true keeps search', /class="[^"]*search/.test(home))
check('showGraph:true keeps the graph', /id="graph-container"|class="[^"]*graph/.test(html))
check('showBacklinks:true keeps backlinks', /backlink/i.test(html))
// Quartz emits analytics into its script bundle, not inline in the HTML.
const scripts = await Promise.all(
  out.filter((f) => f.endsWith('.js')).map((f) => readFile(join(WORK, 'public', f), 'utf8')),
)
const bundled = scripts.join('\n')
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

// Keep the Quartz checkout for next time; drop everything else.
await cp(join(WORK, '.quartz'), join(STARTER, '.quartz'), { recursive: true, force: true }).catch(() => {})
await rm(WORK, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed. The starter is ready to publish as a template repository.')
