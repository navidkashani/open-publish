#!/usr/bin/env node
/**
 * Step 1 of the build: turn the published snapshot into a `content/` directory.
 *
 *   current.json -> snapshots/<id>.json -> objects/<hash> -> content/<slug>
 *
 * Every downloaded object is verified against the hash the snapshot recorded.
 * A mismatch fails the build. That is the point: a corrupted object should
 * never reach the live site, and a failed build with a clear reason is a much
 * better outcome than a silently broken deploy.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { S3Reader, sha256 } from './lib/s3.mjs'
import { rewriteLinks } from './lib/rewrite.mjs'
import { applyNoteMetadata } from './lib/frontmatter.mjs'

const CONTENT_DIR = process.env.OP_CONTENT_DIR ?? 'content'
const STATE_FILE = '.op-build-state.json'
const DOWNLOAD_CONCURRENCY = 8
const MAX_ASSET_BYTES = 25 * 1024 * 1024

function fail(message) {
  console.error(`\n[open-publish] Build stopped.\n\n${message}\n`)
  process.exit(1)
}

async function main() {
  const reader = S3Reader.fromEnv()

  const pointer = await reader.getJson('current.json')
  if (!pointer?.snapshot) {
    fail(
      'No content has been published yet — current.json is missing from the bucket.\n' +
        'Publish from the Obsidian plugin first, then trigger this build again.',
    )
  }

  console.log(`[open-publish] Snapshot ${pointer.snapshot}`)
  const snapshot = await reader.getJson(`snapshots/${pointer.snapshot}.json`)
  if (!snapshot) {
    fail(
      `current.json points at snapshot "${pointer.snapshot}", but that snapshot is not in the bucket.\n` +
        'It may have been removed by a cleanup. Publish again from Obsidian to write a fresh snapshot.',
    )
  }
  if (snapshot.version !== 1) {
    fail(`This starter understands snapshot version 1, but the bucket holds version ${snapshot.version}.
Update the starter repository from the template.`)
  }

  const entries = Object.entries(snapshot.files ?? {})
  console.log(`[open-publish] ${entries.length} file(s) to fetch`)

  // Start from an empty content directory so a file removed from the snapshot
  // cannot survive in a cached workspace.
  await rm(CONTENT_DIR, { recursive: true, force: true })
  await mkdir(CONTENT_DIR, { recursive: true })

  const oversized = entries.filter(([, file]) => file.size > MAX_ASSET_BYTES)
  if (oversized.length > 0) {
    fail(
      `${oversized.length} file(s) exceed the 25 MiB limit that Cloudflare Pages can serve:\n` +
        oversized.map(([path, file]) => `  ${path} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join('\n'),
    )
  }

  let done = 0
  const written = []

  await pool(entries, DOWNLOAD_CONCURRENCY, async ([path, file]) => {
    const body = await reader.get(`objects/${file.hash.slice(0, 2)}/${file.hash}`)
    if (!body) {
      fail(
        `The snapshot lists "${path}" but its content is missing from storage (object ${file.hash}).\n` +
          'Publish again from Obsidian — the upload was probably interrupted.',
      )
    }

    const actual = sha256(body)
    if (actual !== file.hash) {
      fail(
        `"${path}" downloaded corrupted.\n` +
          `  expected sha256 ${file.hash}\n  received sha256 ${actual}\n\n` +
          'Refusing to publish content that does not match the snapshot.',
      )
    }

    if (typeof file.slug !== 'string' || !file.slug) {
      fail(`The snapshot entry for "${path}" has no slug, so there is nowhere to write it.`)
    }
    // Everything here is written to disk by slug. The plugin's slugifier cannot
    // emit a traversal, but this script is the thing holding the pen, so it
    // checks rather than assumes: a clear build failure beats writing outside
    // the content directory.
    if (file.slug.startsWith('/') || file.slug.split('/').includes('..')) {
      fail(`The snapshot entry for "${path}" has a slug that escapes the content directory: ${file.slug}`)
    }

    const isMarkdown = path.toLowerCase().endsWith('.md')
    const target = join(CONTENT_DIR, isMarkdown ? `${file.slug}.md` : file.slug)
    await mkdir(dirname(target), { recursive: true })

    if (isMarkdown) {
      const rewritten = rewriteLinks(body.toString('utf8'), snapshot.links?.[path] ?? [], {
        siteRoot: process.env.OP_SITE_ROOT ?? '',
      })
      // Files are written at their slug, so without the snapshot's resolved
      // title the generator would name every page after its URL.
      await writeFile(target, applyNoteMetadata(rewritten, { title: file.title, aliases: file.aliases }), 'utf8')
    } else {
      await writeFile(target, body)
    }

    written.push(isMarkdown ? `${file.slug}.md` : file.slug)
    if (++done % 50 === 0 || done === entries.length) {
      console.log(`[open-publish] ${done}/${entries.length}`)
    }
  })

  await ensureIndex(snapshot, written)
  const siteOptions = await applySiteConfig(snapshot.site ?? {})

  // Handed to finalize.mjs, which runs after the generator has emitted public/.
  await writeFile(
    STATE_FILE,
    JSON.stringify({ snapshot: snapshot.id, site: siteOptions, redirects: snapshot.redirects ?? [] }, null, 2),
  )

  console.log(`[open-publish] content/ ready (${written.length} file(s))`)
}

/**
 * Quartz needs a page at the site root. If no published note slugs to `index`,
 * generate a simple one rather than failing the build over it.
 */
async function ensureIndex(snapshot, written) {
  if (written.includes('index.md')) return

  const topLevel = Object.entries(snapshot.files ?? {})
    .filter(([path, file]) => path.toLowerCase().endsWith('.md') && !file.slug.includes('/'))
    .map(([, file]) => `- [[${file.slug}|${file.title ?? file.slug}]]`)

  const title = snapshot.site?.title ?? 'Notes'
  const body =
    `---\ntitle: "${title.replace(/"/g, '\\"')}"\n---\n\n` +
    (topLevel.length > 0
      ? `${topLevel.join('\n')}\n`
      : 'Published from Obsidian with Open Publish.\n')

  await writeFile(join(CONTENT_DIR, 'index.md'), body, 'utf8')
  console.log('[open-publish] no note claimed the site root, so a simple index page was generated')
}

/**
 * Write the snapshot's site options into a small generated module that
 * quartz.config.ts and quartz.layout.ts import.
 *
 * A generated module rather than a rewrite of the config file: the config stays
 * entirely the user's to edit, and a merge conflict on every build is avoided.
 */
/**
 * Defaults for every site option this starter understands.
 *
 * The snapshot is merged OVER these rather than replacing them. That matters:
 * a snapshot published by an older plugin will not carry keys added since, and
 * `undefined` is falsy — so replacing wholesale would silently switch off
 * search, navigation and backlinks on somebody's live site.
 */
const DEFAULT_SITE = {
  title: 'My Notes',
  homepage: '',
  noIndex: false,
  showThemeToggle: true,
  strictLineBreaks: false,
  showNavigation: true,
  showSearch: true,
  showGraph: true,
  showOutline: true,
  showBacklinks: true,
  showTags: true,
  analytics: { provider: 'none', id: '' },
}

async function applySiteConfig(rawSite) {
  // Take only keys this starter knows about, so the generated module is an
  // honest statement of what it understands rather than a copy of the snapshot.
  const site = { ...DEFAULT_SITE }
  for (const key of Object.keys(DEFAULT_SITE)) {
    if (rawSite?.[key] !== undefined) site[key] = rawSite[key]
  }
  site.analytics = { ...DEFAULT_SITE.analytics, ...(rawSite?.analytics ?? {}) }

  const unknown = Object.keys(rawSite ?? {}).filter((key) => !(key in DEFAULT_SITE))
  if (unknown.length > 0) {
    // A newer plugin published options this starter predates. Ignoring them is
    // correct; saying so out loud is how somebody finds out to update.
    console.log(`[open-publish] note: ignoring site option(s) this starter does not support: ${unknown.join(', ')}`)
  }

  const body =
    '// Generated by Open Publish on every build from the published snapshot.\n' +
    '// Do not edit — your changes will be overwritten. Change these in Obsidian,\n' +
    '// under Settings -> Open Publish -> Site options.\n' +
    `export const site = ${JSON.stringify(site, null, 2)}\n` +
    'export default site\n'
  await writeFile('op-site.ts', body, 'utf8')
  console.log('[open-publish] site options written to op-site.ts')
  return site
}

async function pool(items, limit, worker) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const index = next++
        if (index >= items.length) return
        await worker(items[index])
      }
    }),
  )
}

main().catch((error) => fail(error.stack ?? String(error)))
