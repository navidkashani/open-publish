/**
 * The manage-folders dialog, driven the way a person drives it.
 *
 * Rule arithmetic is unit tested in `folderrules.test.mjs` and the gesture's
 * timing in `longpress.test.mjs`; what is only findable here is the wiring:
 * whether picking a folder actually stores a rule, whether the × next to a row
 * removes *that* row, and whether the numbers on screen are the ones the
 * arithmetic produced.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Timers the test drives, installed before anything can capture `window`. */
const clock = {
  pending: [],
  setTimeout(handler) {
    return clock.pending.push(handler)
  },
  clearTimeout(id) {
    clock.pending[id - 1] = null
  },
  run() {
    const due = clock.pending
    clock.pending = []
    for (const handler of due) handler?.()
  },
}
globalThis.window ??= { open() {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }

const { byClass, click, dispatch, find, findAll } = await import('./dom.mjs')
const { FolderModal, Platform, fakeApp, fakeSettingsPlugin, menus, modals, suggesters } = await import('./harness.mjs')

const VAULT = {
  folders: ['Notes', 'Notes/Drafts', 'Ideas', 'Archive', 'Archive/2024', '.obsidian'],
  files: [
    'Notes/Luhmann.md',
    'Notes/Zettelkasten.md',
    'Notes/Drafts/Half thought.md',
    'Ideas/WIP.md',
    'Archive/2024/Old.md',
    '.obsidian/data.json',
  ],
}

function open(selection = {}, onDone = () => {}, extra = {}) {
  const app = fakeApp(VAULT)
  const plugin = fakeSettingsPlugin(selection, {}, extra)
  const modal = new FolderModal(app, plugin, onDone)
  modal.open()
  return { app, plugin, modal }
}

/** What Obsidian Publish leaves in the config directory of a vault it published. */
const PUBLISH_FILE = JSON.stringify({
  siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad',
  host: 'publish-01.obsidian.md',
  included: ['Notes', 'Ideas'],
  excluded: [],
})

/** Every rule row on screen: its path, its count, and its warning if it has one. */
function rows(modal) {
  return findAll(modal.contentEl, byClass('op-rule-row')).map((row) => ({
    path: find(row, byClass('op-rule-path')).textContent,
    meta: find(row, byClass('op-rule-meta')).textContent,
    warning: row.hasClass('op-rule-dead') ? find(row, byClass('setting-item-description')).textContent : null,
  }))
}

/** The picker attached to the nth "Add a folder…" box: 0 is Included, 1 is Excluded. */
function picker(modal, index) {
  const input = findAll(modal.contentEl, (node) => node.getAttr('placeholder') === 'Add a folder…')[index]
  return { input, suggest: suggesters.find((candidate) => candidate.inputEl === input) }
}

const rowFor = (modal, path) =>
  findAll(modal.contentEl, byClass('op-rule-row')).find(
    (row) => find(row, byClass('op-rule-path')).textContent === path,
  )

const removeButtonFor = (modal, path) => find(rowFor(modal, path), byClass('op-rule-remove'))

test('both lists open together, each rule with what it currently publishes', () => {
  const { modal } = open({ includes: ['Notes', 'Ideas'], excludes: ['Notes/Drafts'] })

  assert.deepEqual(rows(modal), [
    { path: 'Notes', meta: '2 notes', warning: null },
    { path: 'Ideas', meta: '1 note', warning: null },
    { path: 'Notes/Drafts', meta: '1 note', warning: null },
  ])
  assert.match(modal.contentEl.textContent, /including 2 folders and excluding 1/)
})

test('an include fully shadowed by an exclude reads zero, without opening the publish window', () => {
  const { modal } = open({ includes: ['Notes/Drafts'], excludes: ['Notes'] })
  assert.equal(rows(modal)[0].meta, '0 notes')
})

test('a folder renamed out from under a rule says so', () => {
  const { modal } = open({ includes: ['Old name'] })
  const [row] = rows(modal)
  assert.equal(row.meta, '0 notes')
  assert.match(row.warning, /no longer exists/)
})

test('a rule naming a note is a working rule, not a dead one', () => {
  // `matchesFolderRule` matches an exact file path as well as a prefix, so
  // this publishes one note. A row reading "1 note" and "no longer exists" at
  // the same time is self-contradictory on its face.
  const { modal } = open({ includes: ['Notes/Luhmann.md'] })
  assert.deepEqual(rows(modal), [{ path: 'Notes/Luhmann.md', meta: '1 note', warning: null }])
})

test('picking a folder stores the rule, saves, and the count appears', () => {
  const { modal, plugin } = open()
  picker(modal, 0).suggest.pick('Notes')

  assert.deepEqual(plugin.settings.selection.includes, ['Notes'])
  assert.equal(plugin.saves, 1, 'nothing here is a draft; Done only closes')
  assert.deepEqual(rows(modal), [{ path: 'Notes', meta: '3 notes', warning: null }])
})

test('the picker ranks by what you typed, and highlights the part that matched', () => {
  const { modal } = open()
  const { suggest } = picker(modal, 0)

  assert.deepEqual(suggest.suggestionsFor('drafts'), ['Notes/Drafts'])
  assert.deepEqual(suggest.suggestionsFor('arc'), ['Archive', 'Archive/2024'])

  const rendered = modal.contentEl.createDiv()
  suggest.renderSuggestion('Archive', rendered)
  assert.equal(find(rendered, byClass('suggestion-highlight')).textContent, 'Arc')
  assert.equal(rendered.textContent, 'Archive', 'highlighting must not lose any of the path')
})

test('folders already listed, and dot-folders, are not offered again', () => {
  const { modal } = open({ includes: ['Notes'], excludes: ['Archive'] })
  const offered = picker(modal, 0).suggest.suggestionsFor('')

  assert.equal(offered.includes('Notes'), false, 'already included')
  assert.equal(offered.includes('Archive'), false, 'already excluded: it must not land in both lists')
  assert.equal(offered.includes('.obsidian'), false, 'never publishable, so never offered')
  assert.deepEqual(offered, ['Archive/2024', 'Ideas', 'Notes/Drafts'])
})

test('the vault root is never offered: an empty rule would publish everything', () => {
  const offered = picker(open().modal, 0).suggest.suggestionsFor('')
  assert.equal(offered.includes('/'), false)
  assert.equal(offered.includes(''), false)
})

test('a folder that does not exist yet can still be typed', () => {
  const { modal, plugin } = open()
  const { input } = picker(modal, 0)

  input.value = '/Planned/Series/'
  dispatch(input, 'keydown', { key: 'Enter' })

  assert.deepEqual(plugin.settings.selection.includes, ['Planned/Series'], 'normalised on the way in')
  assert.match(rows(modal)[0].warning, /no longer exists/)
})

test('pressing Enter on an empty box does nothing at all', () => {
  const { modal, plugin } = open()
  const { input } = picker(modal, 0)

  input.value = '   '
  dispatch(input, 'keydown', { key: 'Enter' })
  input.value = '/'
  dispatch(input, 'keydown', { key: 'Enter' })

  assert.deepEqual(plugin.settings.selection.includes, [], 'an empty rule would mean the whole vault')
  assert.equal(plugin.saves, 0)
})

test('the second box adds to excludes, not includes', () => {
  const { modal, plugin } = open({ includes: ['Notes'] })
  assert.equal(rows(modal)[0].meta, '3 notes')

  picker(modal, 1).suggest.pick('Notes/Drafts')

  assert.deepEqual(plugin.settings.selection.includes, ['Notes'])
  assert.deepEqual(plugin.settings.selection.excludes, ['Notes/Drafts'])
  assert.equal(rows(modal)[0].meta, '2 notes', 'and the include recounts straight away')
})

test('the × removes that rule and leaves the others alone', () => {
  const { modal, plugin } = open({ includes: ['Notes', 'Ideas', 'Archive'] })
  click(removeButtonFor(modal, 'Ideas'))

  assert.deepEqual(plugin.settings.selection.includes, ['Notes', 'Archive'])
  assert.deepEqual(
    rows(modal).map((row) => row.path),
    ['Notes', 'Archive'],
  )
})

test('a dead rule is still removable: otherwise it could never be cleaned up', () => {
  const { modal, plugin } = open({ includes: ['Old name'] })
  click(removeButtonFor(modal, 'Old name'))
  assert.deepEqual(plugin.settings.selection.includes, [])
})

test('the remove control is a real button, so Tab reaches it and Enter presses it', () => {
  const { modal } = open({ includes: ['Notes'] })
  const button = removeButtonFor(modal, 'Notes')
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.getAttr('aria-label'), 'Remove Notes')
})

test('an empty list explains itself rather than showing nothing', () => {
  const { modal } = open()
  assert.equal(findAll(modal.contentEl, byClass('op-rule-row')).length, 0)
  assert.match(modal.contentEl.textContent, /No folders yet/)
  assert.match(modal.contentEl.textContent, /Nothing is being held back/)
})

test('Done closes the dialog and tells settings to refresh', () => {
  let refreshed = 0
  const { modal } = open({ includes: ['Notes'] }, () => refreshed++)

  click(find(modal.contentEl, (node) => node.tagName === 'BUTTON' && node.textContent === 'Done'))
  assert.equal(modal.isOpen, false)
  assert.equal(refreshed, 1, 'the summary row and the homepage check both depend on this')
})

test('on a phone, a long press offers Remove: there is no hover to reveal the ×', () => {
  Platform.isMobile = true
  menus.length = 0
  try {
    const { modal, plugin } = open({ includes: ['Notes', 'Ideas'] })
    const row = rowFor(modal, 'Ideas')

    dispatch(row, 'pointerdown', { pointerType: 'touch', clientX: 30, clientY: 90 })
    assert.equal(menus.length, 0, 'nothing happens on touch-down alone')

    clock.run()
    assert.equal(menus.length, 1)
    assert.deepEqual(menus[0].shownAt, { x: 30, y: 90 }, 'the menu opens under the finger')
    assert.deepEqual(
      menus[0].items.map((item) => item.title),
      ['Remove'],
    )

    menus[0].items[0].handler()
    assert.deepEqual(plugin.settings.selection.includes, ['Notes'], 'and only the row held down is gone')
  } finally {
    Platform.isMobile = false
  }
})

test('on desktop no gesture is attached at all: hover already reveals the control', () => {
  menus.length = 0
  const { modal } = open({ includes: ['Notes'] })
  const row = rowFor(modal, 'Notes')

  dispatch(row, 'pointerdown', { pointerType: 'touch', clientX: 0, clientY: 0 })
  clock.run()
  assert.equal(menus.length, 0)
})

test('a vault that never used Obsidian Publish is offered nothing', () => {
  // The whole discoverability rule: the row exists only when the file does.
  const { modal } = open({ includes: ['Notes'] })
  assert.doesNotMatch(modal.contentEl.textContent, /Import from Obsidian Publish/)
})

test('a vault with a Publish configuration is offered the import above both lists', () => {
  const { modal } = open({}, () => {}, { publishConfig: PUBLISH_FILE })
  assert.match(modal.contentEl.textContent, /Import from Obsidian Publish/)
  assert.match(modal.contentEl.textContent, /Manage publish filters/, 'named as Obsidian names it')
})

test('Review import opens the preview, built from the file as it is right now', async () => {
  modals.length = 0
  const { modal } = open({}, () => {}, { publishConfig: PUBLISH_FILE })
  click(find(modal.contentEl, (node) => node.tagName === 'BUTTON' && node.textContent === 'Review import'))
  // The file is re-read on the press, so the preview arrives a tick later.
  await new Promise((resolve) => setImmediate(resolve))

  const preview = modals.at(-1)
  assert.notEqual(preview, modal, 'the preview is its own window')
  assert.match(preview.contentEl.textContent, /configuration lists 2 folders/)
})
