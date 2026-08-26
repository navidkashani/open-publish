/**
 * The Workers Builds config, checked against what the build actually produces.
 *
 * A wrong value here does not fail a build, which is the whole problem: it
 * deploys an empty site, or a site where every internal link 404s, and the
 * deploy still reports success. So the two facts this file asserts are the two
 * that are silent when broken.
 *
 * It also pins the one thing that would break the *other* hosts: a Wrangler file
 * carrying `pages_build_output_dir` stops being local-development-only and
 * starts configuring Pages deployments.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Comments are the point of using .jsonc, so they have to come back out before
 * JSON.parse sees it. Whole-line comments only, which is all the file uses, so
 * a `//` inside a string value cannot be mangled by this.
 */
function readJsonc(url) {
  const text = readFileSync(url, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  return JSON.parse(text)
}

const config = readJsonc(new URL('../wrangler.jsonc', import.meta.url))
const quartzConfig = readFileSync(new URL('../quartz.config.ts', import.meta.url), 'utf8')
const starterPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the assets directory is the directory the build writes', () => {
  // The silent failure: point this somewhere else and Workers deploys an empty
  // site, successfully. `finalize.mjs` and every script agree on public/.
  assert.equal(config.assets.directory, './public')
  assert.match(starterPackage.scripts.build, /build-site\.mjs/)
})

test('a static site with no Worker code declares no Worker code', () => {
  assert.equal('main' in config, false, 'a script here would stop _headers and _redirects applying to its responses')
  assert.ok(config.name, 'Workers Builds fails when this does not match the Worker in the dashboard')
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/, 'pinned, so runtime behaviour does not move on a rebuild')
})

test('a missing page serves the 404 page Quartz actually emits', () => {
  assert.equal(config.assets.not_found_handling, '404-page')
  assert.match(quartzConfig, /NotFoundPage\(\)/, 'or there would be no 404.html to serve')
})

test('extensionless links resolve to the flat files Quartz writes', () => {
  // Quartz emits notes/foo.html and links to /notes/foo. auto-trailing-slash is
  // the mode that serves the first from the second; "none" would 404 every
  // internal link on the site while the deploy still reported success.
  assert.equal(config.assets.html_handling, 'auto-trailing-slash')
})

test('this file stays invisible to Cloudflare Pages', () => {
  // Without `pages_build_output_dir` a Wrangler file is used for local
  // development only, which is what lets one repository serve both hosts. Adding
  // that key would silently take over the build settings of every existing
  // Pages project using this template.
  assert.equal('pages_build_output_dir' in config, false)
})
