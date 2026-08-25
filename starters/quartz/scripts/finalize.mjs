#!/usr/bin/env node
/**
 * Step 3: write the files the plugin and the CDN need, after the generator has
 * produced `public/`.
 *
 * This has to run *after* the build, not before, because generators clear their
 * output directory. Writing `_publish.json` first would mean writing it into a
 * directory that is about to be deleted — and the plugin would then poll
 * forever for a marker that never appears.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

const PUBLIC_DIR = process.env.OP_PUBLIC_DIR ?? 'public'
const STATE_FILE = '.op-build-state.json'

/** Cloudflare Pages: 20,000 assets per deployment on the free plan. */
const MAX_OUTPUT_FILES = 19000
/** Pages refuses to serve any single asset above this. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024
/** Pages supports 2,000 static redirect rules. */
const MAX_REDIRECTS = 2000

function fail(message) {
  console.error(`\n[open-publish] Build stopped.\n\n${message}\n`)
  process.exit(1)
}

async function main() {
  let state
  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'))
  } catch {
    fail(`${STATE_FILE} is missing. Run scripts/fetch-content.mjs before this script.`)
  }

  await mkdir(PUBLIC_DIR, { recursive: true })

  const files = await walk(PUBLIC_DIR)
  if (files.length === 0) {
    fail(
      `The generator produced no files in ${PUBLIC_DIR}/.\n` +
        'Check the build log above for the generator\'s own error.',
    )
  }
  if (files.length > MAX_OUTPUT_FILES) {
    fail(
      `The site has ${files.length} files, over the ${MAX_OUTPUT_FILES} this starter allows.\n` +
        'Cloudflare Pages accepts 20,000 assets per deployment on the free plan. Narrow what you publish in Obsidian.',
    )
  }

  const oversized = files.filter((file) => file.size > MAX_ASSET_BYTES)
  if (oversized.length > 0) {
    fail(
      `${oversized.length} output file(s) exceed the 25 MiB Cloudflare Pages asset limit and would 404:\n` +
        oversized.map((file) => `  ${file.path} (${(file.size / 1024 / 1024).toFixed(1)} MB)`).join('\n'),
    )
  }

  // The marker the plugin polls to know this snapshot is live.
  await writeFile(
    join(PUBLIC_DIR, '_publish.json'),
    JSON.stringify({ snapshot: state.snapshot, builtAt: Date.now() }, null, 2),
    'utf8',
  )

  // Without no-store, a CDN can serve a stale marker and the plugin reports an
  // old snapshot as live — worse than reporting nothing at all.
  const headers = ['/_publish.json', '  Cache-Control: no-store', '  Content-Type: application/json']

  if (state.site?.noIndex) {
    // robots.txt asks crawlers not to index; X-Robots-Tag tells the ones that
    // arrive at a page directly. Both are requests, not access control.
    await writeFile(join(PUBLIC_DIR, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8')
    headers.push('/*', '  X-Robots-Tag: noindex, nofollow')
    console.log('[open-publish] search engines asked not to index this site')
  }

  await writeFile(join(PUBLIC_DIR, '_headers'), headers.join('\n') + '\n', 'utf8')

  const redirects = (state.redirects ?? []).slice(0, MAX_REDIRECTS)
  if (redirects.length > 0) {
    await writeFile(
      join(PUBLIC_DIR, '_redirects'),
      redirects.map((rule) => `/${strip(rule.from)} /${strip(rule.to)} 301`).join('\n') + '\n',
      'utf8',
    )
    console.log(`[open-publish] ${redirects.length} redirect(s) written for renamed notes`)
    if ((state.redirects ?? []).length > MAX_REDIRECTS) {
      console.log(
        `[open-publish] note: ${state.redirects.length - MAX_REDIRECTS} older redirect(s) were dropped ` +
          `to stay within the ${MAX_REDIRECTS}-rule platform limit`,
      )
    }
  }

  console.log(`[open-publish] published snapshot ${state.snapshot} — ${files.length} file(s)`)
}

const strip = (value) => String(value).replace(/^\/+/, '')

async function walk(dir) {
  const out = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push({ path: relative(dir, full), size: (await stat(full)).size })
  }
  return out
}

main().catch((error) => fail(error.stack ?? String(error)))
