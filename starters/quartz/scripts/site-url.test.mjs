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
  assert.equal(resolveBaseUrl({ CF_PAGES_URL: 'https://x.pages.dev' }), 'x.pages.dev')
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

test('a blank host variable falls through instead of winning', () => {
  assert.equal(resolveBaseUrl({ CF_PAGES_URL: '', URL: 'https://x.netlify.app' }), 'x.netlify.app')
})
