/**
 * The customise-navigation dialog, driven the way a person drives it.
 *
 * The arithmetic is unit tested in `navorder.test.mjs`; what is only findable
 * here is the wiring. Whether pressing "move down" actually stores an order,
 * whether the row it stores is the one that was pressed, and whether a row that
 * frontmatter has already decided is left alone rather than offered a control
 * that would silently lose.
 *
 * The three at the end are the ones a mouse-driven pass through the dialog
 * cannot see at all: that an open folder survives the redraw a move causes,
 * that focus comes back to the button that was pressed, and that something says
 * out loud where the row landed. Each of those is invisible until it is the
 * only thing you have.
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
}
globalThis.window ??= { open() {}, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }

const { activeElement, byClass, click, dispatch, find, findAll, visible } = await import('./dom.mjs')
const { NavigationModal, fakeApp, fakeStoragePlugin, navSizeWarning } = await import('./harness.mjs')

const VAULT = {
  folders: ['Notes'],
  files: ['Apple.md', 'Zebra.md', 'Notes/Alpha.md', 'Notes/Beta.md'],
}

function open({ nav, frontmatter = {}, isNotePublished, files = VAULT.files, homepage } = {}) {
  const app = fakeApp({ ...VAULT, files, frontmatter })
  const plugin = fakeStoragePlugin({
    stored: {
      site: { title: 'Notes', ...(homepage ? { homepage } : {}), ...(nav ? { nav } : {}) },
    },
    ...(isNotePublished ? { isNotePublished } : {}),
  })
  const modal = new NavigationModal(app, plugin)
  modal.open()
  return { app, plugin, modal }
}

/** Every row on screen: its name, its badges, and which controls are live. */
function rows(modal) {
  return findAll(modal.contentEl, byClass('op-nav-row')).map((row) => ({
    name: find(row, byClass('op-tree-name')).textContent,
    badges: findAll(row, byClass('op-badge')).map((badge) => badge.textContent),
    hidden: row.hasClass('op-nav-hidden'),
    buttons: findAll(row, byClass('op-nav-button')).map((button) => ({
      label: button.getAttribute('aria-label'),
      enabled: !button.hasAttribute('disabled'),
    })),
  }))
}

const names = (modal) => rows(modal).map((row) => row.name)

/** One row's element, by the name it shows. */
function rowFor(modal, name) {
  return find(
    modal.contentEl,
    (node) => node.hasClass('op-nav-row') && find(node, byClass('op-tree-name'))?.textContent === name,
  )
}

/** The twisty on a folder's row, which is the only thing that folds one. */
const twistyFor = (modal, name) => find(rowFor(modal, name), byClass('op-twisty'))

/** Whatever the dialog last said out loud. It lives outside the redrawn content. */
const announced = (modal) =>
  find(modal.modalEl, (node) => node.getAttribute('aria-live') === 'polite')?.textContent

/** Press the control whose accessible name says what it does. */
function press(modal, label) {
  const button = find(modal.contentEl, (node) => node.getAttribute?.('aria-label') === label)
  assert.ok(button, `no control labelled "${label}"`)
  click(button)
  return button
}

test('the tree opens in the order the site will use: folders first, then notes', () => {
  const { modal } = open()
  assert.deepEqual(names(modal), ['notes', 'Alpha', 'Beta', 'Apple', 'Zebra'])
})

test('moving a row down stores the whole sibling list, not just the pair', () => {
  const { modal, plugin } = open()
  press(modal, 'Move Apple down')
  // The vault path is what gets stored, and the slug is what gets shown: a note
  // that is renamed keeps its place, and a note the manager cannot name has no
  // place to keep.
  assert.deepEqual(plugin.settings.site.nav.order, ['Notes', 'Zebra.md', 'Apple.md'])
  assert.equal(plugin.calls.saves, 1)
  assert.deepEqual(names(modal), ['notes', 'Alpha', 'Beta', 'Zebra', 'Apple'])
})

test('a note can be moved above the folder it sits beside', () => {
  const { modal, plugin } = open()
  press(modal, 'Move Apple up')
  assert.deepEqual(plugin.settings.site.nav.order, ['Apple.md', 'Notes', 'Zebra.md'])
  assert.deepEqual(names(modal), ['Apple', 'notes', 'Alpha', 'Beta', 'Zebra'])
})

test('the first row cannot go up and the last cannot go down', () => {
  const { modal } = open()
  const first = rows(modal)[0]
  assert.deepEqual(
    first.buttons.map((button) => button.enabled),
    [false, true, true],
  )
  const last = rows(modal).at(-1)
  assert.deepEqual(
    last.buttons.map((button) => button.enabled),
    [true, false, true],
  )
})

test('moving happens within a parent only: a child never leaves its folder', () => {
  const { modal, plugin } = open()
  press(modal, 'Move Beta up')
  assert.deepEqual(plugin.settings.site.nav.order, ['Notes/Beta.md', 'Notes/Alpha.md'])
  assert.deepEqual(names(modal), ['notes', 'Beta', 'Alpha', 'Apple', 'Zebra'])
})

test('a row frontmatter has already placed says so and offers no move', () => {
  const { modal } = open({ frontmatter: { 'Apple.md': { 'nav-order': 2 } } })
  const apple = rows(modal).find((row) => row.name === 'Apple')
  assert.deepEqual(apple.badges, ['nav-order: 2'])
  assert.deepEqual(
    apple.buttons.map((button) => button.enabled),
    [false, false, true],
    'it can still be hidden: that is a different decision and frontmatter has not made it',
  )
})

test('a neighbour cannot be swapped past a row frontmatter has placed either', () => {
  // Half a move is worse than none: the swap would appear to work and the
  // resolved order would put the numbered note straight back on top.
  const { modal } = open({ frontmatter: { 'Apple.md': { 'nav-order': 1 } } })
  assert.deepEqual(names(modal), ['Apple', 'notes', 'Alpha', 'Beta', 'Zebra'])
  const folder = rows(modal).find((row) => row.name === 'notes')
  assert.equal(folder.buttons.find((button) => button.label === 'Move notes up').enabled, false)
  assert.equal(folder.buttons.find((button) => button.label === 'Move notes down').enabled, true)
})

// --- hiding ----------------------------------------------------------------

test('hiding a page stores it and dims the row rather than making it vanish', () => {
  const { modal, plugin } = open()
  press(modal, 'Hide Zebra in navigation')
  assert.deepEqual(plugin.settings.site.nav.hidden, ['Zebra.md'])
  const zebra = rows(modal).find((row) => row.name === 'Zebra')
  assert.equal(zebra.hidden, true)
  assert.deepEqual(zebra.badges, ['hidden'])
  assert.equal(
    zebra.buttons.at(-1).label,
    'Show Zebra in navigation',
    'the way back is on the row, not somewhere else',
  )
})

test('turning off "show hidden pages" is how the sidebar gets previewed', () => {
  const { modal } = open({ nav: { order: [], hidden: ['Zebra.md'] } })
  assert.ok(names(modal).includes('Zebra'), 'listed by default, or nothing could ever be un-hidden')
  const toggle = findAll(modal.contentEl, (node) => node.tagName === 'INPUT' && node.type === 'checkbox')[0]
  click(toggle)
  assert.equal(names(modal).includes('Zebra'), false)
})

test('hiding a folder is allowed, and the dialog says what it takes with it', () => {
  const { modal, plugin } = open()
  press(modal, 'Hide notes in navigation')
  assert.deepEqual(plugin.settings.site.nav.hidden, ['Notes'])
  const note = find(modal.contentEl, byClass('op-nav-note'))
  assert.match(note.textContent, /still published/)
  assert.match(note.textContent, /everything inside it/)
})

test('a page frontmatter hides cannot be un-hidden from here, and says which', () => {
  const { modal } = open({ frontmatter: { 'Zebra.md': { 'nav-hidden': true } } })
  const zebra = rows(modal).find((row) => row.name === 'Zebra')
  assert.deepEqual(zebra.badges, ['nav-hidden'])
  assert.equal(zebra.buttons.at(-1).enabled, false)
})

test('a note that refuses to be hidden overrules the manager and shows why', () => {
  const { modal } = open({
    nav: { order: [], hidden: ['Zebra.md'] },
    frontmatter: { 'Zebra.md': { 'nav-hidden': false } },
  })
  const zebra = rows(modal).find((row) => row.name === 'Zebra')
  assert.equal(zebra.hidden, false)
  assert.deepEqual(zebra.badges, ['nav-hidden: false'])
})

// --- the rest of the dialog ------------------------------------------------

test('restore default clears both lists and nothing else', () => {
  const { modal, plugin } = open({ nav: { order: ['Zebra.md', 'Apple.md'], hidden: ['Notes'] } })
  click(find(modal.contentEl, (node) => node.textContent === 'Restore default' && node.tagName === 'BUTTON'))
  assert.deepEqual(plugin.settings.site.nav, { order: [], hidden: [] })
  assert.equal(plugin.settings.site.title, 'Notes', 'it is a navigation control, not a reset button')
})

test('restore default says that frontmatter is not its to restore', () => {
  const { modal } = open({ nav: { order: ['Zebra.md'], hidden: [] } })
  const description = find(
    modal.contentEl,
    (node) => node.hasClass('setting-item-description') && /nav-order/.test(node.textContent),
  )
  assert.match(description.textContent, /live in your notes/)
})

test('a vault publishing nothing says so rather than showing an empty tree', () => {
  const { modal } = open({ isNotePublished: () => false })
  assert.deepEqual(names(modal), [])
  assert.match(find(modal.contentEl, byClass('op-rule-empty')).textContent, /Nothing is being published/)
})

test('the size warning fires on the number of arranged entries, not before', () => {
  assert.equal(navSizeWarning(1), null)
  assert.equal(navSizeWarning(300), null)
  assert.match(navSizeWarning(301), /301 pages are arranged by hand/)
  assert.match(navSizeWarning(301), /every page/)
})

test('an order past the threshold is warned about in the dialog itself', () => {
  const order = Array.from({ length: 400 }, (unused, index) => `Note ${index}.md`)
  const { modal } = open({ nav: { order, hidden: [] } })
  assert.match(find(modal.contentEl, byClass('op-nav-warning')).textContent, /400 pages are arranged/)
})

// --- the homepage ----------------------------------------------------------

test('the homepage is a row like any other, badged so, and can be arranged', () => {
  const { modal, plugin } = open({ homepage: 'Apple.md' })
  assert.deepEqual(names(modal), ['notes', 'Alpha', 'Beta', 'Apple', 'Zebra'])
  assert.deepEqual(rows(modal).find((row) => row.name === 'Apple').badges, ['homepage'])
  press(modal, 'Move Apple up')
  assert.deepEqual(plugin.settings.site.nav.order, ['Apple.md', 'Notes', 'Zebra.md'])
})

test('a homepage that lives in a folder draws at the root, where the site serves it', () => {
  // The badge is doing real work here rather than decorating: the row is not
  // where the file is, and without it that reads as a bug instead of an answer.
  const { modal } = open({ files: [...VAULT.files, 'Notes/Home.md'], homepage: 'Notes/Home.md' })
  assert.deepEqual(names(modal), ['notes', 'Alpha', 'Beta', 'Apple', 'Home', 'Zebra'])
  assert.deepEqual(rows(modal).find((row) => row.name === 'Home').badges, ['homepage'])
})

test('the homepage can be hidden, like anything else in the list', () => {
  const { modal, plugin } = open({ homepage: 'Apple.md' })
  press(modal, 'Hide Apple in navigation')
  assert.deepEqual(plugin.settings.site.nav.hidden, ['Apple.md'])
})

// --- folding ---------------------------------------------------------------

test('folders start closed, so a big vault opens showing its shape', () => {
  const { modal } = open()
  assert.equal(twistyFor(modal, 'notes').hasClass('op-twisty-open'), false)
  assert.equal(visible(rowFor(modal, 'Alpha')), false, 'built, but not on screen until it is asked for')
  assert.equal(visible(rowFor(modal, 'Apple')), true)
})

test('the twisty opens a folder', () => {
  const { modal } = open()
  click(twistyFor(modal, 'notes'))
  assert.equal(twistyFor(modal, 'notes').hasClass('op-twisty-open'), true)
  assert.equal(visible(rowFor(modal, 'Alpha')), true)
  click(twistyFor(modal, 'notes'))
  assert.equal(visible(rowFor(modal, 'Alpha')), false)
})

test('an open folder stays open across a move, or arranging one would be unusable', () => {
  // Every move redraws the whole tree. Without the dialog remembering which
  // folders are open, the tree would slam shut under the row being moved and
  // arranging a folder of ten would be twenty clicks of re-opening it.
  const { modal } = open()
  click(twistyFor(modal, 'notes'))
  press(modal, 'Move Beta up')
  assert.deepEqual(names(modal), ['notes', 'Beta', 'Alpha', 'Apple', 'Zebra'])
  assert.equal(twistyFor(modal, 'notes').hasClass('op-twisty-open'), true)
  assert.equal(visible(rowFor(modal, 'Beta')), true)
})

// --- drag and drop ---------------------------------------------------------

/** A whole drag: pick a row up, hold it over another, let go. */
function drag(modal, from, to) {
  dispatch(rowFor(modal, from), 'dragstart')
  const target = rowFor(modal, to)
  const over = dispatch(target, 'dragover')
  const drop = dispatch(target, 'drop')
  return { target, over, drop }
}

test('dropping a row onto a sibling takes that sibling\'s place', () => {
  const { modal, plugin } = open()
  drag(modal, 'Apple', 'Zebra')
  assert.deepEqual(plugin.settings.site.nav.order, ['Notes', 'Zebra.md', 'Apple.md'])
  assert.deepEqual(names(modal), ['notes', 'Alpha', 'Beta', 'Zebra', 'Apple'])
  assert.equal(plugin.calls.saves, 1)
})

test('a note can be dragged above the folder it sits beside', () => {
  const { modal, plugin } = open()
  drag(modal, 'Zebra', 'notes')
  assert.deepEqual(plugin.settings.site.nav.order, ['Zebra.md', 'Notes', 'Apple.md'])
})

test('the drag and the buttons write the same list, because they are one rule', () => {
  const dragged = open()
  drag(dragged.modal, 'Apple', 'Zebra')
  const pressed = open()
  press(pressed.modal, 'Move Apple down')
  assert.deepEqual(dragged.plugin.settings.site.nav.order, pressed.plugin.settings.site.nav.order)
})

test('the line falls below the target dragging down, and above it dragging up', () => {
  // Which side needs no geometry: the arrays already say which way the row is
  // travelling, and the splice lands it after the target going down and before
  // it going up.
  const down = open().modal
  dispatch(rowFor(down, 'Apple'), 'dragstart')
  const below = rowFor(down, 'Zebra')
  assert.equal(dispatch(below, 'dragover').defaultPrevented, true)
  assert.equal(below.hasClass('op-nav-drop-after'), true)

  const up = open().modal
  dispatch(rowFor(up, 'Zebra'), 'dragstart')
  const above = rowFor(up, 'notes')
  dispatch(above, 'dragover')
  assert.equal(above.hasClass('op-nav-drop-before'), true)
})

test('leaving a row takes its line with it', () => {
  const { modal } = open()
  dispatch(rowFor(modal, 'Apple'), 'dragstart')
  const target = rowFor(modal, 'Zebra')
  dispatch(target, 'dragover')
  dispatch(target, 'dragleave')
  assert.equal(target.hasClass('op-nav-drop-after'), false)
})

test('a drop onto a row in another folder is refused, and draws no line', () => {
  const { modal, plugin } = open()
  click(twistyFor(modal, 'notes'))
  dispatch(rowFor(modal, 'Alpha'), 'dragstart')
  const target = rowFor(modal, 'Apple')
  const over = dispatch(target, 'dragover')
  dispatch(target, 'drop')
  assert.equal(over.defaultPrevented, false, 'a row only becomes a target by accepting the drop')
  assert.equal(target.hasClass('op-nav-drop-before') || target.hasClass('op-nav-drop-after'), false)
  assert.deepEqual(plugin.settings.site.nav.order, [], 'moving a note between folders would move the note')
  assert.equal(plugin.calls.saves, 0)
})

test('a row frontmatter has placed takes no drop either, for the same reason its buttons are off', () => {
  const { modal, plugin } = open({ frontmatter: { 'Zebra.md': { 'nav-order': 2 } } })
  dispatch(rowFor(modal, 'Apple'), 'dragstart')
  const target = rowFor(modal, 'Zebra')
  const over = dispatch(target, 'dragover')
  dispatch(target, 'drop')
  assert.equal(over.defaultPrevented, false)
  assert.equal(target.hasAttribute('draggable'), false, 'and it cannot be picked up in the first place')
  assert.deepEqual(plugin.settings.site.nav.order, [])
})

// --- what happens after a move ---------------------------------------------

const FOUR = ['A.md', 'B.md', 'C.md', 'D.md']

test('focus comes back to the button that was pressed, so a second press is possible', () => {
  // `apply` rebuilds the tree, so the button that was pressed is gone and focus
  // would fall to the body: one Move down, then Tab back from the top.
  const { modal } = open({ files: FOUR })
  const pressed = press(modal, 'Move A down')
  assert.notEqual(activeElement(), pressed, 'that button no longer exists')
  assert.equal(activeElement().getAttribute('aria-label'), 'Move A down')

  press(modal, 'Move A down')
  assert.deepEqual(names(modal), ['B', 'C', 'A', 'D'])
  assert.equal(activeElement().getAttribute('aria-label'), 'Move A down')
})

test('a row that has run out of list gives focus to itself, not to nowhere', () => {
  const { modal } = open({ files: FOUR })
  for (let i = 0; i < 3; i++) press(modal, 'Move A down')
  assert.deepEqual(names(modal), ['B', 'C', 'D', 'A'])
  // A disabled button cannot hold focus, so the row takes it: Tab carries on
  // from the row that moved, and nothing there acts on Enter.
  assert.equal(activeElement().hasClass('op-nav-row'), true)
  assert.equal(find(activeElement(), byClass('op-tree-name')).textContent, 'A')
})

test('hiding puts focus back on the control that did it, which now offers the way back', () => {
  const { modal } = open({ files: FOUR })
  press(modal, 'Hide B in navigation')
  assert.equal(activeElement().getAttribute('aria-label'), 'Show B in navigation')
})

test('a completed move is announced, with where the row landed', () => {
  // The only feedback a drag gives a screen reader at all, and polite because
  // each of these is one finished action rather than a running commentary.
  const { modal } = open({ files: FOUR })
  assert.equal(announced(modal), '')
  press(modal, 'Move A down')
  assert.equal(announced(modal), 'A moved to 2 of 4')
  drag(modal, 'A', 'D')
  assert.equal(announced(modal), 'A moved to 4 of 4')
})
