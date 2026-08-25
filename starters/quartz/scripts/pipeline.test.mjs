/**
 * End-to-end test of the build half of the pipeline.
 *
 * Stands up a real HTTP server that behaves like an S3 bucket, runs the actual
 * build scripts as subprocesses against it, and inspects what lands on disk.
 * This is the verification the plan asks for — happy path, delete, corruption —
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

  for (const [path, { content, slug }] of Object.entries(files)) {
    const buffer = Buffer.from(content)
    const hash = sha256(buffer)
    snapshotFiles[path] = { hash, size: buffer.length, mtime: 1, slug }
    objects.set(`objects/${hash.slice(0, 2)}/${hash}`, corrupt === path ? Buffer.from('tampered') : buffer)
  }

  const snapshot = {
    version: 1,
    id: '2026-08-24T11-04-02Z-a3f9c1',
    parent: null,
    createdAt: Date.now(),
    generator: { plugin: 'open-publish', version: '0.1.0' },
    site: { title: 'My Notes', showGraph: true, showBacklinks: true, showSearch: true, showOutline: true, showTags: true, ...site },
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

test('deleting a note removes it from the site — the content dir is rebuilt, not merged', async () => {
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
