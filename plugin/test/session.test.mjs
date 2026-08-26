/**
 * Run ownership: the publish belongs to the plugin, not to the window.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublishSession } from '../src/core/session.ts'
import { PublishError } from '../src/core/errors.ts'

const summary = { updates: 1, removals: 0, firstPublish: false }

/** A session whose work is driven by hand, so every ordering is reachable. */
function manualSession() {
  let emit
  let resolve
  let reject
  let signal
  const session = new PublishSession({
    summary,
    run: (onEvent, abortSignal) => {
      emit = onEvent
      signal = abortSignal
      return new Promise((res, rej) => {
        resolve = res
        reject = rej
      })
    },
  })
  const outcome = (overrides = {}) => ({
    snapshotId: 's1',
    committed: true,
    uploaded: 1,
    skipped: 0,
    buildTriggered: true,
    deploy: { kind: 'requested' },
    ...overrides,
  })
  return {
    session,
    emit: (event) => emit(event),
    finish: (overrides) => resolve(outcome(overrides)),
    fail: (error) => reject(error),
    aborted: () => signal.aborted,
  }
}

test('closing the window does not cancel the publish', async () => {
  const { session, emit, finish, aborted } = manualSession()

  // A window opens, shows progress, and closes again mid-run.
  const seen = []
  const detach = session.subscribe((status) => seen.push(status.progress.message))
  emit({ phase: 'uploading', message: 'Uploading 2 files…' })
  detach()

  emit({ phase: 'committing', message: 'Saving your notes…', committed: true })
  finish()

  const status = await session.finished
  assert.equal(aborted(), false, 'nothing was aborted')
  assert.equal(status.state, 'done')
  assert.equal(status.outcome.committed, true)
  assert.deepEqual(seen, ['Starting…', 'Uploading 2 files…'], 'the detached view stopped hearing about it')
})

test('reopening attaches to the run in progress and paints straight away', () => {
  const { session, emit } = manualSession()
  emit({ phase: 'uploading', message: 'Uploading 2 files…', current: 1, total: 2 })
  emit({ phase: 'uploading', message: 'Uploading 2 files…', fileDone: { path: 'a.md', skipped: false } })

  let painted = null
  session.subscribe((status) => {
    painted = status
  })
  assert.equal(painted.progress.message, 'Uploading 2 files…')
  assert.equal(painted.progress.current, 1)
  assert.equal(painted.progress.uploadedCount, 1)
  assert.deepEqual(painted.progress.uploadedPaths, ['a.md'])
  assert.equal(painted.state, 'running')
})

test('cancel works right up to the point of no return', async () => {
  const { session, emit, fail, aborted } = manualSession()
  emit({ phase: 'uploading', message: 'Uploading…' })
  assert.equal(session.current().cancellable, true)
  assert.equal(session.cancel(), true)
  assert.equal(aborted(), true)

  fail(new PublishError('aborted', 'Publish cancelled.'))
  const status = await session.finished
  assert.equal(status.state, 'failed')
  assert.equal(status.error.code, 'aborted')
  assert.equal(status.committed, false)
})

test('cancel is a no-op once the notes are saved, and stops being offered', async () => {
  const { session, emit, finish, aborted } = manualSession()
  emit({ phase: 'committing', message: 'Saving your notes…', committed: true })

  assert.equal(session.current().cancellable, false, 'so the button goes away rather than lying')
  assert.equal(session.cancel(), false)
  assert.equal(aborted(), false, 'and nothing was aborted behind the scenes')

  finish()
  const status = await session.finished
  assert.equal(status.committed, true)
})

test('the deploy outcome lands while the run is still going', async () => {
  const { session, emit, finish } = manualSession()
  emit({ phase: 'committing', message: 'Saved.', committed: true })
  emit({ phase: 'triggering', message: '', committed: true, deploy: { kind: 'requested' } })

  assert.equal(session.current().state, 'running', 'verification has not finished')
  assert.deepEqual(session.current().deploy, { kind: 'requested' })

  emit({ phase: 'verifying', message: 'Your site is updating…', committed: true, deploy: { kind: 'requested' } })
  finish({ deploy: { kind: 'live' } })
  const status = await session.finished
  assert.deepEqual(status.deploy, { kind: 'live' }, 'and it is upgraded when the site confirms')
})

test('skipped files are counted, not listed', () => {
  const { session, emit } = manualSession()
  for (const path of ['a.md', 'b.md', 'c.md']) {
    emit({ phase: 'preflight', message: '', fileDone: { path, skipped: true } })
  }
  assert.equal(session.current().progress.skippedCount, 3)
  assert.deepEqual(session.current().progress.uploadedPaths, [])
})

test('the logged path list is capped but the count is not', () => {
  const { session, emit } = manualSession()
  for (let index = 0; index < 250; index++) {
    emit({ phase: 'uploading', message: '', fileDone: { path: `file-${index}.md`, skipped: false } })
  }
  const { progress } = session.current()
  assert.equal(progress.uploadedCount, 250)
  assert.equal(progress.uploadedPaths.length, 200)
  assert.equal(progress.uploadedPaths.at(-1), 'file-199.md')
})

test('a failure is reported in the status rather than thrown at whoever happens to be watching', async () => {
  const { session, fail } = manualSession()
  fail(new Error('the network went away'))
  const status = await session.finished
  assert.equal(status.state, 'failed')
  assert.equal(status.error.message.length > 0, true)
  assert.equal(status.outcome, null)
})

test('the detail line does not outlive its phase', () => {
  const { session, emit } = manualSession()
  emit({ phase: 'preflight', message: 'Checking…', detail: 'one file could not be kept' })
  assert.equal(session.current().progress.detail, 'one file could not be kept')
  emit({ phase: 'uploading', message: 'Uploading…' })
  assert.equal(session.current().progress.detail, undefined)
})

test('a run that publishes nothing still finishes cleanly', async () => {
  const { session, emit, finish } = manualSession()
  emit({ phase: 'done', message: 'Nothing has changed since the last publish. No build needed.' })
  finish({ committed: false, uploaded: 0, buildTriggered: false, deploy: null })
  const status = await session.finished
  assert.equal(status.state, 'done')
  assert.equal(status.committed, false)
  assert.equal(status.deploy, null)
})

test('a detail survives the rest of its phase, so a one-off explanation is readable', () => {
  const { session, emit } = manualSession()
  emit({ phase: 'preflight', message: 'Checking…', detail: 'one file could not be kept' })
  emit({ phase: 'preflight', message: 'Checking…', current: 1, total: 3 })
  assert.equal(session.current().progress.detail, 'one file could not be kept')
})

test('a run that cannot even start reports itself instead of throwing at the caller', async () => {
  const session = new PublishSession({
    summary,
    run: () => {
      throw new PublishError('not-configured', 'Storage is not set up yet.')
    },
  })
  const status = await session.finished
  assert.equal(status.state, 'failed')
  assert.equal(status.error.code, 'not-configured')
  assert.equal(session.isRunning(), false)
})
