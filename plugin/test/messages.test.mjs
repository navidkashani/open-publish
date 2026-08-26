import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REMOVAL_CONFIRM_THRESHOLD,
  RemovalGuard,
  needsRemovalConfirm,
  publishButtonLabel,
  publishMessage,
  removalConfirmLabel,
  reviewSummary,
  stateForSession,
  statusBarLabel,
  upToDateStats,
} from '../src/ui/messages.ts'
import { PublishError } from '../src/core/errors.ts'

const labels = (message) => message.buttons.map((button) => button.label)
const published = (deploy, counts = {}) => ({
  kind: 'published',
  deploy,
  updates: 1,
  removals: 0,
  uploaded: 1,
  ...counts,
})

// --- every row of the message table ----------------------------------------

test('nothing changed', () => {
  const message = publishMessage({ kind: 'nothing-to-publish' })
  assert.equal(message.headline, 'Nothing to publish')
  assert.equal(message.body, 'Your site already matches your notes.')
  assert.deepEqual(labels(message), ['Close'])
})

test('up to date offers only the buttons that can actually work', () => {
  const both = publishMessage({ kind: 'up-to-date', stats: '6 notes published', canVisit: true, canRebuild: true })
  assert.equal(both.headline, 'Your site is up to date')
  assert.equal(both.stats, '6 notes published')
  assert.deepEqual(labels(both), ['Rebuild site', 'Visit site', 'Close'])

  assert.deepEqual(
    labels(publishMessage({ kind: 'up-to-date', stats: '', canVisit: true, canRebuild: false })),
    ['Visit site', 'Close'],
  )
  assert.deepEqual(
    labels(publishMessage({ kind: 'up-to-date', stats: '', canVisit: false, canRebuild: true })),
    ['Rebuild site', 'Close'],
  )
  assert.deepEqual(
    labels(publishMessage({ kind: 'up-to-date', stats: '', canVisit: false, canRebuild: false })),
    ['Close'],
    'a window with nowhere to send you still offers a way out',
  )
})

test('the up-to-date count separates notes from the files that came with them', () => {
  assert.equal(upToDateStats(['a.md', 'b.md']), '2 notes published')
  assert.equal(upToDateStats(['a.md']), '1 note published', 'singular')
  assert.equal(upToDateStats(['a.md', 'img/one.png']), '1 note and 1 attachment published')
  assert.equal(upToDateStats(['a.md', 'b.md', 'img/one.png', 'docs/two.pdf']), '2 notes and 2 attachments published')
  assert.equal(upToDateStats(['img/one.png']), '1 attachment published', 'attachments alone still read')
  assert.equal(upToDateStats([]), 'Nothing published')
})

test('the timestamp is the caller\'s, so this file never touches a locale', () => {
  assert.equal(upToDateStats(['a.md'], '25 Aug 2026, 12:29'), '1 note published · 25 Aug 2026, 12:29')
  assert.equal(upToDateStats(['a.md']), '1 note published', 'and it is left out entirely when unknown')
})

test('publishing offers only cancel', () => {
  const message = publishMessage({ kind: 'publishing', firstPublish: false })
  assert.equal(message.headline, 'Publishing…')
  assert.deepEqual(labels(message), ['Cancel'])
})

test('a first publish explains why it is sending everything', () => {
  const message = publishMessage({ kind: 'publishing', firstPublish: true })
  assert.match(message.body, /first time/)
  assert.match(message.body, /only send what you changed/)
})

test('saved, site updating', () => {
  const message = publishMessage(published({ kind: 'requested' }))
  assert.equal(message.headline, 'Published')
  assert.equal(message.stats, '1 note updated · 1 file uploaded')
  assert.match(message.body, /Your site is updating now/)
  assert.match(message.body, /You can close this window/)
  assert.deepEqual(labels(message), ['Visit site', 'Done'])
})

test('site went live', () => {
  const message = publishMessage(published({ kind: 'live' }))
  assert.equal(message.headline, 'Your site is live')
  assert.deepEqual(labels(message), ['Visit site', 'Done'])
})

test('only removals', () => {
  const message = publishMessage(published({ kind: 'requested' }, { updates: 0, removals: 3, uploaded: 0 }))
  assert.equal(message.headline, 'Published')
  assert.equal(message.stats, '3 pages taken off your site')
  assert.match(message.body, /It's updating now/)
  assert.deepEqual(labels(message), ['Visit site', 'Done'])
})

test('auto-update turned off', () => {
  const message = publishMessage(published({ kind: 'auto-off' }))
  assert.equal(message.headline, 'Saved, not yet live')
  assert.equal(message.body, 'Your notes are saved. Your site will show them the next time it updates.')
  assert.deepEqual(labels(message), ['Update site now', 'Done'])
})

test('held back to save updates', () => {
  const message = publishMessage(published({ kind: 'throttled', agoMinutes: 2 }))
  assert.equal(message.headline, 'Saved, updating shortly')
  assert.match(message.body, /Your site updated 2 minutes ago/)
  assert.match(message.body, /so you don't run out/)
  assert.deepEqual(labels(message), ['Update now anyway', 'Done'])
})

test('setup unfinished', () => {
  const message = publishMessage(published({ kind: 'not-configured' }))
  assert.equal(message.headline, "Saved, but your site won't update")
  assert.equal(message.body, "Open Publish doesn't know how to reach your site yet.")
  assert.deepEqual(labels(message), ['Finish setup', 'Done'])
})

test('site refused the update', () => {
  const message = publishMessage(published({ kind: 'rejected', error: new PublishError('hook-rejected', 'nope') }))
  assert.equal(message.headline, "Saved, but your site didn't update")
  assert.match(message.body, /don't need uploading again/)
  assert.match(message.body, /turned down the request/)
  assert.deepEqual(labels(message), ['Try again', 'Fix in settings'])
})

test('update taking too long', () => {
  const message = publishMessage(published({ kind: 'timeout', logsUrl: 'https://logs.example' }))
  assert.equal(message.headline, 'Saved, still waiting')
  assert.match(message.body, /your old site is still live/)
  assert.deepEqual(labels(message), ['Open build logs', 'Done'])
})

test("can't tell if it worked", () => {
  const message = publishMessage(published({ kind: 'unverifiable' }))
  assert.equal(message.headline, 'Published')
  assert.match(message.body, /Add your site address in settings/)
  assert.deepEqual(labels(message), ['Open settings', 'Done'])
})

test('upload failed', () => {
  const message = publishMessage({ kind: 'failed', code: 'storage-failed', message: 'Storage said no.' })
  assert.equal(message.headline, "Couldn't publish")
  assert.match(message.body, /Your site is unchanged/)
  assert.match(message.body, /trying again is quick/)
  assert.deepEqual(labels(message), ['Try again', 'Close'])
})

test('offline', () => {
  const message = publishMessage({ kind: 'failed', code: 'storage-unreachable', message: 'no route' })
  assert.equal(message.headline, "Can't reach your storage")
  assert.equal(message.body, 'Check your connection and try again. Nothing was changed.')
  assert.deepEqual(labels(message), ['Try again', 'Close'])
})

test('wrong credentials', () => {
  const message = publishMessage({ kind: 'failed', code: 'storage-credentials', message: 'rejected' })
  assert.equal(message.headline, 'Storage rejected your keys')
  assert.equal(message.body, 'They may be wrong, removed, or for a different bucket.')
  assert.deepEqual(labels(message), ['Open settings', 'Close'])
})

test('someone published first', () => {
  const message = publishMessage({ kind: 'failed', code: 'storage-conflict', message: 'moved' })
  assert.equal(message.headline, 'Someone else published')
  assert.match(message.body, /Nothing was overwritten/)
  assert.deepEqual(labels(message), ['See what changed', 'Close'])
})

test('cancelled', () => {
  const message = publishMessage({ kind: 'failed', code: 'aborted', message: 'Publish cancelled.' })
  assert.equal(message.headline, 'Publish cancelled')
  assert.equal(message.body, 'Your site is unchanged.')
  assert.deepEqual(labels(message), ['Close'])
})

test('no message in the whole table uses our jargon', () => {
  const states = [
    { kind: 'nothing-to-publish' },
    { kind: 'nothing-to-publish', reason: 'nothing-selected' },
    { kind: 'up-to-date', stats: '6 notes published', canVisit: true, canRebuild: true },
    { kind: 'up-to-date', stats: '', canVisit: false, canRebuild: false },
    { kind: 'publishing', firstPublish: true },
    published({ kind: 'requested' }),
    published({ kind: 'live' }),
    published({ kind: 'unverifiable' }),
    published({ kind: 'auto-off' }),
    published({ kind: 'throttled', agoMinutes: 2 }),
    published({ kind: 'not-configured' }),
    published({ kind: 'rejected', error: new PublishError('hook-rejected', 'nope') }),
    published({ kind: 'timeout' }),
    { kind: 'failed', code: 'aborted', message: 'x' },
    { kind: 'failed', code: 'storage-conflict', message: 'x' },
    { kind: 'failed', code: 'storage-credentials', message: 'x' },
    { kind: 'failed', code: 'storage-unreachable', message: 'x' },
  ]
  const banned = /\b(snapshot|commit|committed|hook|quota|etag|preflight)\b/i
  for (const state of states) {
    const message = publishMessage(state)
    const text = [message.headline, message.stats, message.body].filter(Boolean).join(' ')
    assert.equal(banned.test(text), false, `"${text}" leaks jargon`)
    assert.ok(message.buttons.length > 0, 'every message offers a way out')
  }
})

test('once the notes are saved, nothing says "failed"', () => {
  const deploys = [
    { kind: 'requested' },
    { kind: 'live' },
    { kind: 'unverifiable' },
    { kind: 'auto-off' },
    { kind: 'throttled', agoMinutes: 1 },
    { kind: 'not-configured' },
    { kind: 'rejected', error: new PublishError('hook-rejected', 'nope') },
    { kind: 'timeout' },
  ]
  for (const deploy of deploys) {
    const message = publishMessage(published(deploy))
    const text = `${message.headline} ${message.body ?? ''}`
    assert.equal(/fail/i.test(text), false, `${deploy.kind} used the word "failed"`)
  }
})

// --- reading a session ------------------------------------------------------

const status = (overrides = {}) => ({
  state: 'running',
  committed: false,
  cancellable: true,
  progress: { phase: 'uploading', message: '', uploadedCount: 2, skippedCount: 0, uploadedPaths: [] },
  deploy: null,
  outcome: null,
  error: null,
  ...overrides,
})
const summary = { updates: 1, removals: 0, firstPublish: false }

test('a run in flight reads as publishing', () => {
  assert.deepEqual(stateForSession(status(), summary), { kind: 'publishing', firstPublish: false })
})

test('the success screen arrives with the deploy request, not with the deploy', () => {
  const state = stateForSession(status({ committed: true, deploy: { kind: 'requested' } }), summary)
  assert.equal(state.kind, 'published')
  assert.equal(publishMessage(state).headline, 'Published')
})

test('committed but still uploading nothing yet is not a result screen', () => {
  const state = stateForSession(status({ committed: true, deploy: null }), summary)
  assert.equal(state.kind, 'publishing')
})

test('a failure after the notes are saved is a site problem, never a failed publish', () => {
  const state = stateForSession(
    status({ state: 'failed', committed: true, error: new PublishError('storage-failed', 'boom') }),
    summary,
  )
  assert.equal(state.kind, 'published')
  assert.equal(publishMessage(state).headline, 'Saved, still waiting')
})

test('a failure before the notes are saved is reported as one', () => {
  const state = stateForSession(
    status({ state: 'failed', error: new PublishError('storage-unreachable', 'offline') }),
    summary,
  )
  assert.deepEqual(labels(publishMessage(state)), ['Try again', 'Close'])
})

test('a finished run that committed nothing had nothing to publish', () => {
  assert.equal(stateForSession(status({ state: 'done' }), summary).kind, 'nothing-to-publish')
})

test('the status bar says something short and true at every stage', () => {
  assert.equal(statusBarLabel({ kind: 'publishing', firstPublish: false }), 'Publishing…')
  assert.equal(statusBarLabel(published({ kind: 'requested' })), 'Site updating…')
  assert.equal(statusBarLabel(published({ kind: 'live' })), 'Your site is live')
  assert.equal(statusBarLabel({ kind: 'failed', code: 'aborted', message: 'x' }), 'Publish cancelled')
  assert.equal(statusBarLabel({ kind: 'nothing-to-publish' }), 'Nothing to publish')
  assert.equal(
    statusBarLabel({ kind: 'up-to-date', stats: '', canVisit: false, canRebuild: false }),
    'Your site is up to date',
  )
})

// --- the review screen ------------------------------------------------------

test('the publish button says what happens, never a file count', () => {
  assert.equal(publishButtonLabel({ changes: 1, removals: 0 }), 'Publish 1 change')
  assert.equal(publishButtonLabel({ changes: 3, removals: 0 }), 'Publish 3 changes')
  assert.equal(publishButtonLabel({ changes: 2, removals: 1 }), 'Publish 2 changes and 1 removal')
  assert.equal(publishButtonLabel({ changes: 0, removals: 4 }), 'Publish 4 removals')
  assert.equal(publishButtonLabel({ changes: 0, removals: 0 }), 'Publish')
})

test('the summary line counts the three things that matter', () => {
  assert.equal(reviewSummary({ changed: 1, added: 2, removed: 3 }), '1 changed · 2 new · 3 removed')
  assert.equal(reviewSummary({ changed: 0, added: 2, removed: 0 }), '2 new')
  assert.equal(reviewSummary({ changed: 0, added: 0, removed: 0 }), 'no changes')
})

test('removals need confirming above five, not below', () => {
  assert.equal(needsRemovalConfirm(REMOVAL_CONFIRM_THRESHOLD), false)
  assert.equal(needsRemovalConfirm(REMOVAL_CONFIRM_THRESHOLD + 1), true)
  assert.equal(needsRemovalConfirm(0), false)
  assert.equal(removalConfirmLabel(43), 'This takes 43 pages off your site. Publish anyway?')
})

test('a small removal publishes on the first click', () => {
  const guard = new RemovalGuard()
  assert.equal(guard.confirm(3), true)
  assert.equal(guard.isArmed(), false)
})

test('a big removal takes two clicks', () => {
  const guard = new RemovalGuard()
  assert.equal(guard.confirm(43), false, 'the first click only asks')
  assert.equal(guard.isArmed(), true)
  assert.equal(guard.confirm(43), true, 'the second goes ahead')
  assert.equal(guard.isArmed(), false, 'and the question is not left standing')
})

test('any tick resets the confirmation: the number on the button just changed', () => {
  const guard = new RemovalGuard()
  assert.equal(guard.confirm(43), false)
  guard.reset()
  assert.equal(guard.isArmed(), false)
  assert.equal(guard.confirm(43), false, 'so it has to be asked again')
})

test('a fresh install is empty, not "already up to date"', () => {
  const message = publishMessage({ kind: 'nothing-to-publish', reason: 'nothing-selected' })
  assert.equal(message.headline, 'Nothing to publish')
  assert.match(message.body, /No notes are marked for publishing yet/)
  assert.deepEqual(labels(message), ['Close'])
})
