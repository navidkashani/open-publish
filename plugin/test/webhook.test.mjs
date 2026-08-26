import test from 'node:test'
import assert from 'node:assert/strict'
import { WebhookBuilder, parseMarker } from '../src/builders/webhook.ts'

const config = {
  url: 'https://api.cloudflare.com/hook/abc',
  method: 'POST',
  siteUrl: 'https://my-notes.pages.dev',
  logsUrl: 'https://dash.cloudflare.com/logs',
}

const noSleep = async () => {}
const respond = (responses) => {
  const calls = []
  const client = async (request) => {
    calls.push(request)
    const next = typeof responses === 'function' ? responses(calls.length, request) : responses.shift()
    return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '', ...(next ?? {}) }
  }
  return { client, calls }
}

test('triggering posts to the hook and names the snapshot in the body', async () => {
  const { client, calls } = respond([{ status: 200, text: '{"id":"job-1"}' }])
  const result = await new WebhookBuilder(config, client, noSleep).trigger('snap-1')
  assert.equal(result.accepted, true)
  assert.equal(result.ref, 'job-1')
  assert.equal(calls[0].url, config.url)
  assert.equal(JSON.parse(calls[0].body).snapshot, 'snap-1')
})

test('an empty hook response is still a success: most providers return nothing', async () => {
  const { client } = respond([{ status: 200, text: '' }])
  assert.deepEqual(await new WebhookBuilder(config, client, noSleep).trigger('snap-1'), { accepted: true, ref: undefined })
})

test('a deleted hook produces an actionable message, not a status code', async () => {
  const { client } = respond([{ status: 404, text: 'not found' }])
  await assert.rejects(
    () => new WebhookBuilder(config, client, noSleep).trigger('snap-1'),
    (error) => error.code === 'hook-rejected' && /Create a new deploy hook/.test(error.hint),
  )
})

test('polling stops as soon as the site serves the expected snapshot', async () => {
  const { client, calls } = respond((n) =>
    n < 3
      ? { status: 200, text: JSON.stringify({ snapshot: 'old-snap' }) }
      : { status: 200, text: JSON.stringify({ snapshot: 'snap-1' }) },
  )
  const states = []
  for await (const state of new WebhookBuilder(config, client, noSleep).waitForDeploy('snap-1', { timeoutMs: 60_000 })) {
    states.push(state.state)
  }
  assert.deepEqual(states, ['pending', 'pending', 'live'])
  assert.equal(calls.length, 3)
})

test('every poll is cache-busted so a CDN cannot report a stale snapshot as live', async () => {
  const { client, calls } = respond((n) => ({ status: 200, text: JSON.stringify({ snapshot: n < 2 ? 'old' : 'snap-1' }) }))
  for await (const _ of new WebhookBuilder(config, client, noSleep).waitForDeploy('snap-1', { timeoutMs: 60_000 })) { /* drain */ }
  const nonces = calls.map((call) => new URL(call.url).searchParams.get('t'))
  assert.ok(nonces.every(Boolean), 'every request carries a nonce')
  assert.equal(new Set(nonces).size, nonces.length, 'and each one is different')
  assert.ok(calls[0].url.startsWith('https://my-notes.pages.dev/_publish.json?t='))
})

test('a site that never updates times out instead of polling forever', async () => {
  const { client } = respond(() => ({ status: 200, text: JSON.stringify({ snapshot: 'other' }) }))
  const states = []
  // A zero timeout means the deadline has already passed on the first check.
  for await (const state of new WebhookBuilder(config, client, noSleep).waitForDeploy('snap-1', { timeoutMs: 0 })) {
    states.push(state.state)
  }
  assert.deepEqual(states, ['timeout'])
})

test('errors and 5xx during a deploy are treated as pending, not as failure', async () => {
  const { client } = respond((n) => {
    if (n === 1) throw new Error('connection reset mid-deploy')
    if (n === 2) return { status: 502, text: '' }
    return { status: 200, text: JSON.stringify({ snapshot: 'snap-1' }) }
  })
  const states = []
  for await (const state of new WebhookBuilder(config, client, noSleep).waitForDeploy('snap-1', { timeoutMs: 60_000 })) {
    states.push(state.state)
  }
  assert.deepEqual(states, ['pending', 'pending', 'live'])
})

test('cancelling stops the polling loop', async () => {
  const controller = new AbortController()
  controller.abort()
  const { client, calls } = respond(() => ({ status: 200, text: '{}' }))
  const states = []
  for await (const state of new WebhookBuilder(config, client, noSleep).waitForDeploy('snap-1', { timeoutMs: 60_000, signal: controller.signal })) {
    states.push(state.state)
  }
  assert.deepEqual(states, ['timeout'])
  assert.equal(calls.length, 0)
})

test('the site check reports the live snapshot and never starts a build', async () => {
  const { client, calls } = respond([{ status: 200, text: JSON.stringify({ snapshot: 'snap-9' }) }])
  const result = await new WebhookBuilder(config, client, noSleep).test()
  assert.equal(result.ok, true)
  assert.match(result.reason, /snap-9/)
  assert.ok(calls.every((call) => call.method === 'GET'), 'the hook is never called')
})

test('a site with no marker yet is fine, not an error', async () => {
  const { client } = respond([{ status: 404, text: '' }])
  const result = await new WebhookBuilder(config, client, noSleep).test()
  assert.equal(result.ok, true)
  assert.match(result.reason, /has not been built by Open Publish yet/)
})

test('a malformed URL is caught before any request is made', async () => {
  const { client, calls } = respond([])
  const result = await new WebhookBuilder({ ...config, siteUrl: 'my-notes.pages.dev' }, client, noSleep).test()
  assert.equal(result.ok, false)
  assert.match(result.reason, /not a valid URL/)
  assert.equal(calls.length, 0)
})

test('marker parsing rejects anything without a snapshot id', () => {
  assert.deepEqual(parseMarker('{"snapshot":"s","builtAt":5}'), { snapshot: 's', builtAt: 5 })
  assert.equal(parseMarker('<!doctype html>'), null, 'an HTML 404 page must not read as a marker')
  assert.equal(parseMarker('{"builtAt":5}'), null)
})
