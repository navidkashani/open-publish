/**
 * Site history, driven the way a person drives it.
 *
 * The arithmetic is unit tested in `rollback.test.mjs`. What is only findable
 * here is whether the window *says* it: whether a version whose content is gone
 * can still be clicked, whether the confirm screen names the `noIndex` flip
 * before somebody agrees to it, and whether a build that failed after the
 * pointer moved is reported as a build that failed rather than as a rollback
 * that did.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window ??= { open() {} }

const { byClass, click, find, findAll } = await import('./dom.mjs')
const { RollbackModal, fakeApp, notices } = await import('./harness.mjs')

const OLD = '2026-08-14T09-12-00Z-aaaaaa'
const LIVE = '2026-08-20T11-30-00Z-bbbbbb'

const stamp = (id) =>
  new Date(Date.UTC(2026, 7, Number(id.slice(8, 10)), Number(id.slice(11, 13)), Number(id.slice(14, 16))))

const version = (id, over = {}) => ({
  id,
  createdAt: stamp(id).getTime(),
  fileCount: 3,
  live: false,
  restorable: true,
  ...over,
})

const plan = (over = {}) => ({
  target: { id: OLD, site: {}, files: {} },
  from: LIVE,
  diff: { added: [], changed: [], unchanged: [], removed: [] },
  optionChanges: [],
  missingObjects: 0,
  behind: true,
  pointerExists: true,
  expectedEtag: 'pointer-1',
  ...over,
})

/** A plugin that answers the three questions the window asks, and counts them. */
function fakeRollbackPlugin(over = {}) {
  const calls = { lists: 0, plans: [], rollbacks: [] }
  return {
    calls,
    async listSiteVersions() {
      calls.lists++
      if (over.listError) throw over.listError
      return over.list ?? { versions: [version(LIVE, { live: true }), version(OLD)], truncated: 0 }
    },
    async planRollback(id) {
      calls.plans.push(id)
      if (over.planError) throw over.planError
      return over.plan ?? plan()
    },
    async rollBackTo(target) {
      calls.rollbacks.push(target)
      if (over.rollbackError) throw over.rollbackError
      return over.result ?? { snapshotId: OLD, build: 'started' }
    },
  }
}

/** Open the window and let the listing settle. */
async function open(over = {}, onDone = () => {}) {
  notices.length = 0
  const plugin = fakeRollbackPlugin(over)
  const modal = new RollbackModal(fakeApp(), plugin, onDone)
  modal.open()
  await settle()
  return { modal, plugin }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const rows = (modal) => findAll(modal.contentEl, byClass('op-provider-row'))
const rowFor = (modal, name) =>
  rows(modal).find((row) => find(row, byClass('op-provider-name')).textContent === name)
const buttonNamed = (modal, text) =>
  find(modal.contentEl, (node) => node.tagName === 'BUTTON' && node.textContent === text)

// --- the list --------------------------------------------------------------

test('the window lists every version, newest first, with a badge on the live one', async () => {
  const { modal } = await open()

  assert.equal(modal.titleEl.textContent, 'Site history')
  assert.deepEqual(
    rows(modal).map((row) => find(row, byClass('op-provider-name')).textContent),
    [stamp(LIVE).toLocaleString(), stamp(OLD).toLocaleString()],
  )
  assert.equal(find(rows(modal)[0], byClass('op-provider-badge')).textContent, 'Live')
  assert.equal(find(rows(modal)[1], byClass('op-provider-badge')), null)
})

test('the live version is not a target: making it live again would spend a build to do nothing', async () => {
  const { modal, plugin } = await open()
  click(rows(modal)[0])
  await settle()
  assert.deepEqual(plugin.calls.plans, [])
})

test('a version whose content is gone is shown, greyed, with the reason, and cannot be picked', async () => {
  const { modal, plugin } = await open({
    list: {
      versions: [
        version(LIVE, { live: true }),
        version(OLD, { restorable: false, unavailable: '2 of its file(s) are no longer in storage.' }),
      ],
      truncated: 0,
    },
  })

  const row = rows(modal)[1]
  assert.equal(row.hasClass('is-unavailable'), true)
  assert.equal(row.getAttr('aria-disabled'), 'true')
  assert.match(find(row, byClass('op-provider-caution-line')).textContent, /no longer in storage/)

  click(row)
  await settle()
  assert.deepEqual(plugin.calls.plans, [], 'a pointer to it would build a site with missing pages')
})

test('a history longer than the window says how much it did not show', async () => {
  const { modal } = await open({ list: { versions: [version(LIVE, { live: true })], truncated: 7 } })
  assert.match(find(modal.contentEl, byClass('op-version-truncated')).textContent, /7 older version\(s\)/)
})

test('an empty history explains itself rather than showing nothing', async () => {
  const { modal } = await open({ list: { versions: [], truncated: 0 } })
  assert.equal(rows(modal).length, 0)
  assert.match(modal.contentEl.textContent, /no published versions in your storage yet/)
})

test('a listing that fails says so in a sentence, and offers a way back', async () => {
  const { modal } = await open({ listError: new Error('bucket unreachable') })
  assert.ok(find(modal.contentEl, byClass('op-notice-error')))
  assert.match(modal.contentEl.textContent, /Your site history could not be read/)
  assert.ok(buttonNamed(modal, 'Back'))
})

// --- the confirm -----------------------------------------------------------

async function confirm(over = {}) {
  const opened = await open(over)
  click(rowFor(opened.modal, stamp(OLD).toLocaleString()))
  await settle()
  return opened
}

test('picking a version asks what it would change before changing anything', async () => {
  const { modal, plugin } = await confirm()
  assert.deepEqual(plugin.calls.plans, [OLD])
  assert.deepEqual(plugin.calls.rollbacks, [], 'nothing is committed by looking')
  assert.match(modal.contentEl.textContent, new RegExp(`Making the ${stamp(OLD).toLocaleString()} version live`))
})

test('the confirm names what comes off the site and what goes back', async () => {
  const { modal } = await confirm({
    plan: plan({
      diff: { added: [], changed: ['Notes/Index.md'], unchanged: ['a.md'], removed: ['Notes/Private.md'] },
    }),
  })
  const text = find(modal.contentEl, byClass('op-version-diff')).textContent
  assert.match(text, /1 page comes off the site: Notes\/Private\.md/)
  assert.match(text, /1 page goes back to its earlier version: Notes\/Index\.md/)
})

test('the confirm names a noIndex flip from hidden to visible, in the warning colour', async () => {
  // The worst surprise available in this feature: the person most likely to be
  // here is the person who just published something private.
  const { modal } = await confirm({
    plan: plan({
      optionChanges: [
        { option: 'Hide from search engines', before: 'on', after: 'off', warn: true },
        { option: 'Site title', before: '"Notes"', after: '"Old notes"' },
      ],
    }),
  })

  const options = findAll(modal.contentEl, byClass('op-version-option'))
  assert.match(options[0].textContent, /Hide from search engines: on → off/)
  assert.equal(options[0].hasClass('op-version-option-warn'), true)
  assert.equal(options[1].hasClass('op-version-option-warn'), false)
})

test('the confirm says both of the things it would otherwise be inferred to mean', async () => {
  const { modal } = await confirm()
  const honesty = find(modal.contentEl, byClass('op-version-honesty')).textContent
  assert.match(honesty, /Nothing changes until the site rebuilds/)
  assert.match(honesty, /stay in your storage/, 'un-publishing is not deleting, and must not read as it')
  assert.match(honesty, /does not delete them/)
})

test('the commit button is marked as the consequential one', async () => {
  const { modal } = await confirm()
  assert.equal(buttonNamed(modal, 'Make this live').hasClass('mod-warning'), true)
})

test('Back returns to the list without committing anything', async () => {
  const { modal, plugin } = await confirm()
  click(buttonNamed(modal, 'Back'))
  await settle()
  assert.equal(rows(modal).length, 2)
  assert.deepEqual(plugin.calls.rollbacks, [])
})

// --- committing ------------------------------------------------------------

test('Make this live commits the plan, reports it, and closes', async () => {
  let refreshed = 0
  const opened = await open({}, () => refreshed++)
  click(rowFor(opened.modal, stamp(OLD).toLocaleString()))
  await settle()

  click(buttonNamed(opened.modal, 'Make this live'))
  await settle()

  assert.equal(opened.plugin.calls.rollbacks.length, 1)
  assert.equal(opened.modal.isOpen, false)
  assert.equal(refreshed, 1, 'the settings panel this raises is drawn somewhere else')
  assert.match(notices.at(-1), /That version is live\. Your site is rebuilding now\./)
})

test('a build that never started is reported as that, never as a failed rollback', async () => {
  // The pointer moved. Nothing the host does afterwards turns that into a
  // rollback that did not happen.
  const { modal } = await confirm({ result: { snapshotId: OLD, build: 'failed', buildError: 'Hook returned 404.' } })
  click(buttonNamed(modal, 'Make this live'))
  await settle()

  assert.match(notices.at(-1), /^That version is live\./)
  assert.match(notices.at(-1), /build could not be started: Hook returned 404\./)
})

test('with no deploy hook it says plainly that the site will not change yet', async () => {
  const { modal } = await confirm({ result: { snapshotId: OLD, build: 'not-configured' } })
  click(buttonNamed(modal, 'Make this live'))
  await settle()
  assert.match(notices.at(-1), /no deploy hook set up, so your site will not change until it is built again/)
})

test('a refused commit leaves the window open and says why', async () => {
  const { modal } = await confirm({ rollbackError: new Error('Another device published.') })
  click(buttonNamed(modal, 'Make this live'))
  await settle()

  assert.equal(modal.isOpen, true)
  assert.match(modal.contentEl.textContent, /Another device published\./)
})

test('closing the window mid-listing cancels it rather than drawing into nothing', async () => {
  const plugin = fakeRollbackPlugin()
  let resolveList = () => {}
  plugin.listSiteVersions = () =>
    new Promise((resolve) => {
      resolveList = () => resolve({ versions: [version(LIVE, { live: true })], truncated: 0 })
    })

  const modal = new RollbackModal(fakeApp(), plugin)
  modal.open()
  modal.close()
  resolveList()
  await settle()

  assert.equal(modal.contentEl.children.length, 0, 'a closed window must not repaint itself')
})

test('a version collected between the list and the click is refused before the button, not after it', async () => {
  // The row was drawn from the list's verdict; the plan recounts from a fresh
  // listing. When a clean-up ran in between, offering an enabled button that is
  // guaranteed to be refused tells somebody the choice is theirs when it is not.
  const { modal, plugin } = await confirm({ plan: plan({ missingObjects: 4 }) })

  assert.equal(buttonNamed(modal, 'Make this live'), null)
  assert.match(modal.contentEl.textContent, /cannot be made live/)
  assert.match(modal.contentEl.textContent, /4 file\(s\)/)
  assert.deepEqual(plugin.calls.rollbacks, [])
})
