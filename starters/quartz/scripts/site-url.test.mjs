import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBaseUrl } from './lib/site-url.mjs'

test('returns undefined, never an empty string, when nothing is set', () => {
  // The whole point: Quartz's `cfg.baseUrl ?? "example.com"` fallback is skipped
  // by '', which then fails the build with an opaque "Invalid URL".
  assert.equal(resolveBaseUrl({}), undefined)
  assert.equal(resolveBaseUrl({ OP_SITE_URL: '' }), undefined)
  assert.equal(resolveBaseUrl({ OP_SITE_URL: '   ' }), undefined)
})

test('strips the scheme and any trailing slash', () => {
  assert.equal(resolveBaseUrl({ OP_SITE_URL: 'https://notes.example.com/' }), 'notes.example.com')
  assert.equal(resolveBaseUrl({ OP_SITE_URL: 'http://notes.example.com' }), 'notes.example.com')
  assert.equal(resolveBaseUrl({ OP_SITE_URL: 'notes.example.com' }), 'notes.example.com')
})

test('knows each host\'s own variable', () => {
  assert.equal(resolveBaseUrl({ CF_PAGES_URL: 'https://notes.pages.dev' }), 'notes.pages.dev')
  assert.equal(resolveBaseUrl({ DEPLOY_PRIME_URL: 'https://x.netlify.app' }), 'x.netlify.app')
  assert.equal(resolveBaseUrl({ URL: 'https://x.netlify.app' }), 'x.netlify.app')
  assert.equal(resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }), 'x.vercel.app')
  assert.equal(resolveBaseUrl({ VERCEL_URL: 'x-abc.vercel.app' }), 'x-abc.vercel.app')
})

test('an explicit override beats the host, for custom domains', () => {
  assert.equal(
    resolveBaseUrl({ OP_SITE_URL: 'https://notes.example.com', CF_PAGES_URL: 'https://x.pages.dev' }),
    'notes.example.com',
  )
})

// --- Cloudflare Pages -------------------------------------------------------

test('a Pages deployment host fails the build instead of becoming the canonical', () => {
  // `2f8bfad6.notes.pages.dev` is the deployment's own address: a fresh hash on
  // every deploy, served `x-robots-tag: noindex`. As `baseUrl` it would put a
  // canonical, an og:url and a sitemap on every page naming a host Google is
  // forbidden to index, and the site would fall out of the index.
  assert.throws(
    () => resolveBaseUrl({ CF_PAGES: '1', CF_PAGES_URL: 'https://2f8bfad6.notes.pages.dev' }),
    /OP_SITE_URL/,
    'the failure has to name the variable that fixes it',
  )
})

test('OP_SITE_URL is what makes a Pages build succeed, and it wins outright', () => {
  assert.equal(
    resolveBaseUrl({
      CF_PAGES_URL: 'https://2f8bfad6.notes.pages.dev',
      OP_SITE_URL: 'https://notes.example.com',
    }),
    'notes.example.com',
  )
})

test('a stable Pages alias is a real address and passes straight through', () => {
  // Only the hash shape is refused. A project or branch alias names the site.
  assert.equal(resolveBaseUrl({ CF_PAGES_URL: 'https://notes.pages.dev' }), 'notes.pages.dev')
  assert.equal(
    resolveBaseUrl({ CF_PAGES_URL: 'https://feature-x.notes.pages.dev' }),
    'feature-x.notes.pages.dev',
  )
  // Eight characters, but not eight *hex* characters: a branch, not a hash.
  assert.equal(
    resolveBaseUrl({ CF_PAGES_URL: 'https://redesign.notes.pages.dev' }),
    'redesign.notes.pages.dev',
  )
})

test('a blank host variable falls through instead of winning', () => {
  assert.equal(resolveBaseUrl({ CF_PAGES_URL: '', URL: 'https://x.netlify.app' }), 'x.netlify.app')
})

// --- Workers Builds ---------------------------------------------------------

test('Workers Builds with no address fails the build instead of shipping example.com', () => {
  // It sets WORKERS_CI and no URL variable of any kind, so every lookup above
  // misses and Quartz writes the feed, the sitemap and the 404 page for
  // example.com. Silently, on the host our own docs call forward-looking.
  assert.throws(
    () => resolveBaseUrl({ WORKERS_CI: '1', CI: 'true', WORKERS_CI_BRANCH: 'main' }),
    /OP_SITE_URL/,
    'the failure has to name the variable that fixes it',
  )
})

test('Workers Builds with an address set resolves like anywhere else', () => {
  assert.equal(
    resolveBaseUrl({ WORKERS_CI: '1', OP_SITE_URL: 'https://notes.example.com' }),
    'notes.example.com',
  )
})

test('every other host keeps returning undefined, so nothing else moves', () => {
  assert.equal(resolveBaseUrl({ CI: 'true' }), undefined)
  assert.equal(resolveBaseUrl({ WORKERS_CI: '' }), undefined, 'a blank variable is not a Workers build')
})
