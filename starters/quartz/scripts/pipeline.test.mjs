/**
 * End-to-end test of the build half of the pipeline.
 *
 * Stands up a real HTTP server that behaves like an S3 bucket, runs the actual
 * build scripts as subprocesses against it, and inspects what lands on disk.
 * This is the verification the plan asks for (happy path, delete, corruption),
 * exercised without a live Cloudflare account.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** A minimal S3-shaped bucket. Signatures are accepted without checking; the plugin suite covers signing. */
function startBucket(objects) {
  const server = createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url, 'http://localhost').pathname.replace(/^\/test-bucket\//, ''))
    const body = objects.get(key)
    if (!body) {
      response.writeHead(404, { 'Content-Type': 'application/xml' })
      response.end('<Error><Code>NoSuchKey</Code></Error>')
      return
    }
    response.writeHead(200, { 'Content-Length': body.length })
    response.end(body)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function makeBucket({ files, links = {}, redirects = [], corrupt = null, site = {} }) {
  const objects = new Map()
  const snapshotFiles = {}

  for (const [path, { content, slug, legacyUrls }] of Object.entries(files)) {
    const buffer = Buffer.from(content)
    const hash = sha256(buffer)
    snapshotFiles[path] = { hash, size: buffer.length, mtime: 1, slug, ...(legacyUrls ? { legacyUrls } : {}) }
    objects.set(`objects/${hash.slice(0, 2)}/${hash}`, corrupt === path ? Buffer.from('tampered') : buffer)
  }

  const snapshot = {
    version: 1,
    id: '2026-08-24T11-04-02Z-a3f9c1',
    parent: null,
    createdAt: Date.now(),
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site: { title: 'My Notes', showGraph: true, showBacklinks: true, showSearch: true, showOutline: true, showTags: true, showPageMetadata: false, showPrevNext: true, ...site },
    files: snapshotFiles,
    links,
    redirects,
  }

  objects.set(`snapshots/${snapshot.id}.json`, Buffer.from(JSON.stringify(snapshot)))
  objects.set('current.json', Buffer.from(JSON.stringify({ version: 1, snapshot: snapshot.id, updatedAt: Date.now() })))
  return { objects, snapshot }
}

function runScript(script, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SCRIPTS, script)], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function withBucket(config, body) {
  const { objects, snapshot } = makeBucket(config)
  const { server, port } = await startBucket(objects)
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  const env = {
    OP_ENDPOINT: `http://127.0.0.1:${port}`,
    OP_BUCKET: 'test-bucket',
    OP_REGION: 'auto',
    OP_ACCESS_KEY_ID: 'key',
    OP_SECRET_ACCESS_KEY: 'secret',
  }
  try {
    return await body({ cwd, env, snapshot, objects })
  } finally {
    server.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

const listFiles = async (dir) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name).replace(dir + '/', ''))
  }
  return out.sort()
}

test('the happy path: a snapshot becomes a content tree at slug paths', async () => {
  await withBucket(
    {
      files: {
        'Notes/Zettelkasten.md': { content: '# Zettelkasten\n\nSee [[Luhmann]].\n', slug: 'notes/zettelkasten' },
        'Notes/Luhmann.md': { content: '# Luhmann\n', slug: 'notes/luhmann' },
        'attachments/diagram.png': { content: 'PNGDATA', slug: 'attachments/diagram.png' },
      },
      links: {
        'Notes/Zettelkasten.md': [
          { raw: 'Luhmann', target: 'Notes/Luhmann.md', status: 'published', slug: 'notes/luhmann' },
        ],
      },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)

      const files = await listFiles(join(cwd, 'content'))
      assert.deepEqual(files, ['attachments/diagram.png', 'index.md', 'notes/luhmann.md', 'notes/zettelkasten.md'])

      const note = await readFile(join(cwd, 'content/notes/zettelkasten.md'), 'utf8')
      assert.ok(note.includes('[Luhmann](/notes/luhmann)'), 'the link was resolved into a site URL')

      const asset = await readFile(join(cwd, 'content/attachments/diagram.png'))
      assert.equal(asset.toString(), 'PNGDATA', 'binary assets pass through unchanged')

      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.ok(opSite.includes('"title": "My Notes"'))
    },
  )
})

test('a corrupted object fails the build instead of deploying bad content', async () => {
  await withBucket(
    {
      files: { 'a.md': { content: '# Real content\n', slug: 'a' } },
      corrupt: 'a.md',
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /downloaded corrupted/)
      assert.match(result.stderr, /expected sha256/)
      assert.match(result.stderr, /Refusing to publish content/)
    },
  )
})

test('a missing object names the file, not just the hash', async () => {
  const { objects, snapshot } = makeBucket({ files: { 'Notes/Gone.md': { content: 'x', slug: 'notes/gone' } } })
  const hash = snapshot.files['Notes/Gone.md'].hash
  objects.delete(`objects/${hash.slice(0, 2)}/${hash}`)
  const { server, port } = await startBucket(objects)
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  try {
    const result = await runScript('fetch-content.mjs', cwd, {
      OP_ENDPOINT: `http://127.0.0.1:${port}`, OP_BUCKET: 'test-bucket', OP_REGION: 'auto',
      OP_ACCESS_KEY_ID: 'k', OP_SECRET_ACCESS_KEY: 's',
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Notes\/Gone\.md/)
    assert.match(result.stderr, /upload was probably interrupted/)
  } finally {
    server.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deleting a note removes it from the site: the content dir is rebuilt, not merged', async () => {
  await withBucket(
    { files: { 'keep.md': { content: 'keep', slug: 'keep' } } },
    async ({ cwd, env }) => {
      // A file left over from an earlier build in a cached workspace.
      await mkdir(join(cwd, 'content/notes'), { recursive: true })
      await writeFile(join(cwd, 'content/notes/stale.md'), 'should not survive')

      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)

      const files = await listFiles(join(cwd, 'content'))
      assert.ok(!files.includes('notes/stale.md'), 'a file no longer in the snapshot is gone from the site')
      assert.ok(files.includes('keep.md'))
    },
  )
})

test('missing environment variables produce a fixable message, not a stack trace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  try {
    const result = await runScript('fetch-content.mjs', cwd, {
      OP_ENDPOINT: '', OP_BUCKET: '', OP_ACCESS_KEY_ID: '', OP_SECRET_ACCESS_KEY: '',
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Missing environment variable\(s\)/)
    assert.match(result.stderr, /Environment variables/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('an unpublished bucket says so instead of failing obscurely', async () => {
  const { server, port } = await startBucket(new Map())
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  try {
    const result = await runScript('fetch-content.mjs', cwd, {
      OP_ENDPOINT: `http://127.0.0.1:${port}`, OP_BUCKET: 'test-bucket', OP_REGION: 'auto',
      OP_ACCESS_KEY_ID: 'k', OP_SECRET_ACCESS_KEY: 's',
    })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /No content has been published yet/)
  } finally {
    server.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('finalize writes the marker, the no-store header and the redirects', async () => {
  await withBucket(
    {
      files: { 'a.md': { content: 'a', slug: 'notes/new-name' } },
      redirects: [{ from: 'notes/old-name', to: 'notes/new-name' }],
    },
    async ({ cwd, env, snapshot }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)

      // Stand in for the generator's output.
      await mkdir(join(cwd, 'public'), { recursive: true })
      await writeFile(join(cwd, 'public/index.html'), '<html></html>')

      const result = await runScript('finalize.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)

      const marker = JSON.parse(await readFile(join(cwd, 'public/_publish.json'), 'utf8'))
      assert.equal(marker.snapshot, snapshot.id, 'the plugin polls for exactly this')
      assert.ok(typeof marker.builtAt === 'number')

      const headers = await readFile(join(cwd, 'public/_headers'), 'utf8')
      assert.match(headers, /\/_publish\.json/)
      assert.match(headers, /Cache-Control: no-store/)

      const redirects = await readFile(join(cwd, 'public/_redirects'), 'utf8')
      assert.equal(redirects.trim(), '/notes/old-name /notes/new-name 301')
    },
  )
})

test('finalize refuses to publish an empty output directory', async () => {
  await withBucket({ files: { 'a.md': { content: 'a', slug: 'a' } } }, async ({ cwd, env }) => {
    assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
    await mkdir(join(cwd, 'public'), { recursive: true })
    const result = await runScript('finalize.mjs', cwd, env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /produced no files/)
  })
})

test('finalize blocks an asset Cloudflare Pages could not serve', async () => {
  await withBucket({ files: { 'a.md': { content: 'a', slug: 'a' } } }, async ({ cwd, env }) => {
    assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
    await mkdir(join(cwd, 'public'), { recursive: true })
    await writeFile(join(cwd, 'public/huge.bin'), Buffer.alloc(26 * 1024 * 1024))
    const result = await runScript('finalize.mjs', cwd, env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /25 MiB/)
  })
})

test('finalize without fetch-content having run says which step is missing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  try {
    const result = await runScript('finalize.mjs', cwd, {})
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Run scripts\/fetch-content\.mjs before/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('site options from the snapshot reach the generated module', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { showGraph: false, title: 'Different' } },
    async ({ cwd, env }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"showGraph": false/)
      assert.match(opSite, /"title": "Different"/)
    },
  )
})

test('a note claiming the site root is used instead of a generated index', async () => {
  await withBucket(
    { files: { 'Home.md': { content: '# Home\n', slug: 'index' } } },
    async ({ cwd, env }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
      const index = await readFile(join(cwd, 'content/index.md'), 'utf8')
      assert.equal(index, '# Home\n', 'the real note, not a generated stub')
    },
  )
})

test('an older snapshot missing new options gets defaults, not silent switch-offs', async () => {
  // The failure this guards against: `undefined` is falsy, so replacing the
  // defaults wholesale would turn search and navigation off on a live site.
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { title: 'Old Snapshot' } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"title": "Old Snapshot"/)
      assert.match(opSite, /"showSearch": true/)
      assert.match(opSite, /"showNavigation": true/)
      assert.match(opSite, /"showThemeToggle": true/)
      assert.match(opSite, /"provider": "none"/)
      // Language and direction arrived after this starter shipped, and this is
      // why no snapshot version bump was needed for them: a manifest that
      // predates them is not broken by them, it just gets the same English,
      // left-to-right site it has always built.
      assert.match(opSite, /"locale": "en-US"/)
      assert.match(opSite, /"dir": "ltr"/)
      // And the four newest, which arrive the same way. `showPageMetadata`
      // defaults *off*, so this is the one place the rule cuts the other way:
      // a snapshot that predates it gets no metadata block rather than one.
      assert.match(opSite, /"showPageMetadata": false/)
      assert.match(opSite, /"showPrevNext": true/)
      assert.match(opSite, /"showHoverPreview": true/)
      assert.match(opSite, /"showInlineTitle": true/)
    },
  )
})

test('the metadata toggle reaches the module the layout reads', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { showPageMetadata: true } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"showPageMetadata": true/)
      assert.doesNotMatch(result.stdout, /ignoring site option/, 'it is an option this starter knows')
    },
  )
})

/**
 * Quartz has no previous/next component, so this option has nothing to render.
 * Carrying it anyway is the contract in `docs/architecture.md`: options are
 * intent, and a starter that cannot express one ignores it rather than
 * reporting it as unknown, which would teach the user their plugin is too new.
 */
test('an option this starter carries but cannot render is not reported as unknown', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { showPrevNext: false } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(await readFile(join(cwd, 'op-site.ts'), 'utf8'), /"showPrevNext": false/)
      assert.doesNotMatch(result.stdout, /ignoring site option/)
    },
  )
})

test('the hover and inline-title toggles reach the module the layout reads', async () => {
  await withBucket(
    {
      files: { 'a.md': { content: 'a', slug: 'a' } },
      site: { showHoverPreview: false, showInlineTitle: false },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"showHoverPreview": false/)
      assert.match(opSite, /"showInlineTitle": false/)
      assert.doesNotMatch(result.stdout, /ignoring site option/, 'both are options this starter knows')
    },
  )
})

/**
 * Read as source rather than rendered, for the reason `wrangler.test.mjs` reads
 * `quartz.config.ts` the same way: `quartz.layout.ts` imports `./quartz/cfg` and
 * `./quartz/components`, which exist only inside an assembled template, so there
 * is nothing here to import.
 *
 * What it catches is the one mistake worth catching. `ArticleTitle` appears in
 * both layouts, and honouring the option in the list layout too would leave
 * folder listings, tag indexes and the 404 page with no heading above a bare
 * list. Obsidian Publish, where the option comes from, has no such pages, so
 * "hide inline title" never meant them.
 */
test('the inline title is optional on content pages and fixed on list pages', async () => {
  const layout = await readFile(join(SCRIPTS, '../quartz.layout.ts'), 'utf8')
  const contentAt = layout.indexOf('export const defaultContentPageLayout')
  const listAt = layout.indexOf('export const defaultListPageLayout')
  assert.ok(contentAt > 0 && listAt > contentAt, 'both layouts have to be in there for this to mean anything')

  const content = layout.slice(contentAt, listAt)
  const list = layout.slice(listAt)
  assert.match(content, /\.\.\.optional\(site\.showInlineTitle, Component\.ArticleTitle\(\)\)/)
  assert.match(list, /^\s*Component\.ArticleTitle\(\),$/m, 'a list page is named by nothing else')
  assert.doesNotMatch(list, /showInlineTitle/)
})

test('a snapshot that names a right-to-left language carries both keys through', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { locale: 'fa-IR', dir: 'rtl' } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"locale": "fa-IR"/)
      assert.match(opSite, /"dir": "rtl"/)
      assert.doesNotMatch(result.stdout, /ignoring site option/, 'both are options this starter knows')
    },
  )
})

test('an arranged navigation reaches the module the layout reads', async () => {
  await withBucket(
    {
      files: { 'a.md': { content: 'a', slug: 'a' } },
      site: { nav: { order: ['notes/index', 'a'], hidden: ['secret'] } },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"order": \[\s*"notes\/index",\s*"a"\s*\]/)
      assert.match(opSite, /"hidden": \[\s*"secret"\s*\]/)
      assert.doesNotMatch(result.stdout, /ignoring site option/, 'it is an option this starter knows')
    },
  )
})

test('a snapshot with no navigation block still builds, with both lists empty', async () => {
  // The case `applySiteConfig` exists to protect: a manifest published before
  // this option existed must build the site it always did rather than reading
  // the length of `undefined`.
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { title: 'Old Snapshot' } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(await readFile(join(cwd, 'op-site.ts'), 'utf8'), /"nav": \{\s*"order": \[\],\s*"hidden": \[\]\s*\}/)
    },
  )
})

test('the folder names reach the module the layout reads', async () => {
  await withBucket(
    {
      files: { 'a.md': { content: 'a', slug: 'a' } },
      site: { folders: { 'wisdom-approaches/index': 'Wisdom & Approaches' } },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"wisdom-approaches\/index": "Wisdom & Approaches"/)
      assert.doesNotMatch(result.stdout, /ignoring site option/, 'it is an option this starter knows')
    },
  )
})

test('a snapshot with no folder names still builds, with an empty map', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { title: 'Old Snapshot' } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(await readFile(join(cwd, 'op-site.ts'), 'utf8'), /"folders": \{\}/)
    },
  )
})

test('a folder name that is not a pair of strings is dropped rather than rendered', async () => {
  // Written straight into a page, so a snapshot off the network is not trusted
  // to have put strings in it.
  await withBucket(
    {
      files: { 'a.md': { content: 'a', slug: 'a' } },
      site: { folders: { 'good/index': 'Good', 'bad/index': 42, '': 'Nameless' } },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"good\/index": "Good"/)
      assert.doesNotMatch(opSite, /bad\/index/)
      assert.doesNotMatch(opSite, /Nameless/)
    },
  )
})

test('half a navigation block does not leave the other half undefined', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { nav: { order: ['a'] } } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"order": \[\s*"a"\s*\]/)
      assert.match(opSite, /"hidden": \[\]/)
    },
  )
})

test('an option this starter predates is ignored, and says so', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { showStackedPages: true } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0)
      assert.match(result.stdout, /ignoring site option\(s\) this starter does not support: showStackedPages/)
      assert.doesNotMatch(await readFile(join(cwd, 'op-site.ts'), 'utf8'), /showStackedPages/)
    },
  )
})

test('a partial analytics block keeps its default provider', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { analytics: { id: 'G-123' } } },
    async ({ cwd, env }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
      const opSite = await readFile(join(cwd, 'op-site.ts'), 'utf8')
      assert.match(opSite, /"provider": "none"/)
      assert.match(opSite, /"id": "G-123"/)
    },
  )
})

test('noIndex writes robots.txt and the header rule', async () => {
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' } }, site: { noIndex: true } },
    async ({ cwd, env }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
      await mkdir(join(cwd, 'public'), { recursive: true })
      await writeFile(join(cwd, 'public/index.html'), '<html></html>')
      assert.equal((await runScript('finalize.mjs', cwd, env)).code, 0)

      assert.match(await readFile(join(cwd, 'public/robots.txt'), 'utf8'), /User-agent: \*\nDisallow: \/2?/)
      assert.match(await readFile(join(cwd, 'public/_headers'), 'utf8'), /X-Robots-Tag: noindex/)
    },
  )
})

test('without noIndex there is no robots.txt at all', async () => {
  await withBucket({ files: { 'a.md': { content: 'a', slug: 'a' } } }, async ({ cwd, env }) => {
    assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
    await mkdir(join(cwd, 'public'), { recursive: true })
    await writeFile(join(cwd, 'public/index.html'), '<html></html>')
    assert.equal((await runScript('finalize.mjs', cwd, env)).code, 0)
    await assert.rejects(() => readFile(join(cwd, 'public/robots.txt'), 'utf8'))
    assert.doesNotMatch(await readFile(join(cwd, 'public/_headers'), 'utf8'), /X-Robots-Tag/)
  })
})

test('a note renamed into the homepage slot redirects to the site root, not to /index', async () => {
  // Quartz emits the homepage at `/`; `/index` is a path it never produced, so
  // the old URL of a note that became the homepage would land on a 404.
  const cwd = await mkdtemp(join(tmpdir(), 'op-build-'))
  try {
    await writeFile(
      join(cwd, '.op-build-state.json'),
      JSON.stringify({
        snapshot: 's1',
        site: {},
        redirects: [
          { from: 'notes/home', to: 'index' },
          { from: 'notes/old', to: 'notes/new' },
        ],
      }),
    )
    await mkdir(join(cwd, 'public'), { recursive: true })
    await writeFile(join(cwd, 'public/index.html'), '<html></html>')

    assert.equal((await runScript('finalize.mjs', cwd, {})).code, 0)
    const redirects = await readFile(join(cwd, 'public/_redirects'), 'utf8')
    assert.match(redirects, /^\/notes\/home \/ 301$/m, 'the homepage redirect points at the root')
    assert.match(redirects, /^\/notes\/old \/notes\/new 301$/m, 'and every other one is unaffected')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the build follows current.json when it moves, content and site options together', async () => {
  // This is the whole of a rollback, from the build's side: the plugin rewrites
  // one ~60-byte key and the next build has to serve a different site. Nothing
  // in the plugin's own suite can show that, because the thing that has to
  // follow the pointer lives here.
  await withBucket(
    {
      files: {
        'Notes/Keep.md': { content: '# Keep', slug: 'keep' },
        'Notes/Private.md': { content: '# Private', slug: 'private' },
      },
      site: { noIndex: true },
    },
    async ({ cwd, env, snapshot, objects }) => {
      assert.equal((await runScript('fetch-content.mjs', cwd, env)).code, 0)
      assert.ok((await listFiles(join(cwd, 'content'))).includes('private.md'))

      // The version before the private note was published, and before the site
      // was hidden from search engines. Its one object is already in the bucket:
      // same bytes, same hash, which is why a rollback uploads nothing.
      const older = {
        ...snapshot,
        id: '2026-08-14T09-12-00Z-aaaaaa',
        files: { 'Notes/Keep.md': snapshot.files['Notes/Keep.md'] },
        site: { ...snapshot.site, noIndex: false },
      }
      objects.set(`snapshots/${older.id}.json`, Buffer.from(JSON.stringify(older)))
      objects.set('current.json', Buffer.from(JSON.stringify({ version: 1, snapshot: older.id, updatedAt: Date.now() })))

      const rebuilt = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(rebuilt.code, 0, rebuilt.stderr)

      const files = await listFiles(join(cwd, 'content'))
      assert.ok(files.includes('keep.md'))
      assert.equal(files.includes('private.md'), false, 'the page the rollback takes off has to leave the tree')

      const state = JSON.parse(await readFile(join(cwd, '.op-build-state.json'), 'utf8'))
      assert.equal(state.snapshot, older.id, 'and the marker names the version the site is now built from')

      // The site options go back with the content, which is why the plugin's
      // confirm step names them. Here that is robots.txt appearing and going.
      await mkdir(join(cwd, 'public'), { recursive: true })
      await writeFile(join(cwd, 'public/index.html'), '<html></html>')
      assert.equal((await runScript('finalize.mjs', cwd, env)).code, 0)
      await assert.rejects(
        () => readFile(join(cwd, 'public/robots.txt'), 'utf8'),
        'rolling back past "hide from search engines" really does un-hide the site',
      )
    },
  )
})

test('a rollback to a version whose objects were collected fails the build loudly', async () => {
  // The plugin refuses this before it writes the pointer. If something ever
  // gets past that guard, the build must stop rather than deploy a site with
  // holes in it.
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a' }, 'gone.md': { content: 'gone', slug: 'gone' } } },
    async ({ cwd, env, snapshot, objects }) => {
      const collected = snapshot.files['gone.md'].hash
      objects.delete(`objects/${collected.slice(0, 2)}/${collected}`)

      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.notEqual(result.code, 0, 'a half-built site is worse than a failed build')
      assert.match(result.stderr, /gone\.md/, 'and it names the file, not just the hash')
    },
  )
})

test('a note that moved off Obsidian Publish carries its old URL into the content tree', async () => {
  // The half of the old-URL story this suite can prove on its own: the old
  // address reaches the working copy as `permalink`, unmangled, `&` and Persian
  // included. What Quartz then does with it is a real build's business, and
  // `npm run verify` is where that is checked.
  await withBucket(
    {
      files: {
        'Wisdom & Approaches/Critical Thinking.md': {
          content: '# Critical Thinking\n',
          slug: 'wisdom-approaches/critical-thinking',
          legacyUrls: ['Wisdom+&+Approaches/Critical+Thinking'],
        },
        'یادداشت‌ها/تفکر نقاد.md': {
          content: '# تفکر نقاد\n',
          slug: 'یادداشت-ها/تفکر-نقاد',
          legacyUrls: ['یادداشت‌ها/تفکر+نقاد'],
        },
        'notes/plain.md': { content: '# Plain\n', slug: 'notes/plain' },
      },
    },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 0, result.stderr)

      const moved = await readFile(join(cwd, 'content/wisdom-approaches/critical-thinking.md'), 'utf8')
      assert.match(moved, /^permalink: "Wisdom\+&\+Approaches\/Critical\+Thinking"$/m)

      const persian = await readFile(join(cwd, 'content/یادداشت-ها/تفکر-نقاد.md'), 'utf8')
      assert.match(persian, /^permalink: "یادداشت‌ها\/تفکر\+نقاد"$/m)

      const plain = await readFile(join(cwd, 'content/notes/plain.md'), 'utf8')
      assert.doesNotMatch(plain, /permalink/, 'a note already at its old address needs no second page')
    },
  )
})

test('an old URL that would escape the content directory stops the build', async () => {
  // The slug is checked for this already. An old URL is a path the *generator*
  // writes to, which is further from this script rather than nearer, so it gets
  // the same check and the same clear failure.
  await withBucket(
    { files: { 'a.md': { content: 'a', slug: 'a', legacyUrls: ['../../etc/passwd'] } } },
    async ({ cwd, env }) => {
      const result = await runScript('fetch-content.mjs', cwd, env)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /escapes the content directory/)
      assert.match(result.stderr, /a\.md/, 'and it names the file')
    },
  )
})
