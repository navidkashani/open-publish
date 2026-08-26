/**
 * The status bar is the only sign a publish is still going once the window is
 * closed, and it runs inside the session's subscribe callback, which the
 * plugin calls synchronously. Anything it gets wrong shows up as a Publish
 * button that appears to do nothing, so it is worth its own tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { el } from './dom.mjs'
import { Platform, StatusBar } from './harness.mjs'

globalThis.window ??= { open() {}, setTimeout, clearTimeout }

function host() {
  const items = []
  return {
    items,
    addStatusBarItem() {
      const item = el()
      items.push(item)
      return item
    },
  }
}

const status = (overrides = {}) => ({
  state: 'running',
  committed: false,
  cancellable: true,
  progress: { phase: 'uploading', message: '', uploadedCount: 0, skippedCount: 0, uploadedPaths: [], current: 3, total: 8 },
  deploy: null,
  outcome: null,
  error: null,
  ...overrides,
})

test('a running publish shows a count, so a closed window is not a black hole', () => {
  const stage = host()
  const bar = new StatusBar(stage, () => {})
  bar.update(status(), { kind: 'publishing', firstPublish: false })

  const item = stage.items[0]
  assert.equal(item.hidden, false)
  assert.match(item.textContent, /Publishing… 3\/8/)
  assert.equal(item.hasClass('op-status-bar-busy'), true)
})

test('clicking it reopens the publish window', () => {
  const stage = host()
  let opened = 0
  new StatusBar(stage, () => opened++)
  stage.items[0].dispatchEvent({ type: 'click', target: null })
  assert.equal(opened, 1)
})

test('a finished publish says what happened and then gets out of the way', () => {
  const stage = host()
  const bar = new StatusBar(stage, () => {})
  bar.update(status({ state: 'done', committed: true, deploy: { kind: 'live' } }), {
    kind: 'published',
    deploy: { kind: 'live' },
    updates: 1,
    removals: 0,
    uploaded: 1,
  })

  const item = stage.items[0]
  assert.match(item.textContent, /Your site is live/)
  assert.equal(item.hasClass('op-status-bar-busy'), false)
  assert.match(item.getAttr('aria-label'), /1 note updated/)
})

test('nothing running means nothing on the bar', () => {
  const stage = host()
  const bar = new StatusBar(stage, () => {})
  bar.update(status(), { kind: 'publishing', firstPublish: false })
  bar.update(null, null)
  assert.equal(stage.items[0].hidden, true)
})

test('mobile has no status bar, so none is claimed', () => {
  Platform.isMobile = true
  try {
    const stage = host()
    const bar = new StatusBar(stage, () => {})
    bar.update(status(), { kind: 'publishing', firstPublish: false })
    assert.equal(stage.items.length, 0, 'and the result is announced by a notice instead')
  } finally {
    Platform.isMobile = false
  }
})

test('every phase the bar can be handed renders without throwing', () => {
  const stage = host()
  const bar = new StatusBar(stage, () => {})
  const states = [
    { kind: 'publishing', firstPublish: true },
    { kind: 'nothing-to-publish' },
    { kind: 'published', deploy: { kind: 'requested' }, updates: 1, removals: 0, uploaded: 1 },
    { kind: 'published', deploy: { kind: 'throttled', agoMinutes: 2 }, updates: 1, removals: 0, uploaded: 0 },
    { kind: 'published', deploy: { kind: 'timeout' }, updates: 0, removals: 3, uploaded: 0 },
    { kind: 'failed', code: 'storage-unreachable', message: 'offline' },
  ]
  for (const state of states) {
    bar.update(status({ state: 'done' }), state)
    assert.ok(stage.items[0].textContent.length > 0, `${state.kind} rendered nothing`)
  }
  bar.dispose()
})
