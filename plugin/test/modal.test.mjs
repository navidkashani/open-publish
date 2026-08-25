/**
 * The publish window, driven the way a person drives it.
 *
 * Tree logic and message wording are unit tested elsewhere; what is only
 * findable here is the wiring — whether a click on a checkbox leaves the
 * checkbox where the user put it, and whether the Publish button actually
 * starts a publish.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { byClass, click, find, findAll, visible } from './dom.mjs'
import { MODAL_MEMBERS, PublishModal, fakePlugin } from './harness.mjs'
import { site } from './helpers.mjs'

globalThis.window ??= { open() {}, setTimeout, clearTimeout }

const file = (hash, slug) => ({ hash, size: 73, mtime: 1, slug })

const previous = {
  version: 1,
  id: '2026-08-25T07-23-25Z-f1482e',
  parent: null,
  createdAt: 1_600_000_000_000,
  generator: { plugin: 'open-publish', version: '0.1.0' },
  site,
  files: {
    'Notes/This is just a test.md': file('old', 'notes/this-is-just-a-test'),
    'attachments/diagram.png': file('h-img', 'attachments/diagram.png'),
    'Notes/Café Résumé.md': file('h-cafe', 'notes/cafe-resume'),
    'Notes/Home.md': file('h-home', 'index'),
    'Notes/Luhmann.md': file('h-luh', 'notes/luhmann'),
    'Notes/Zettelkasten.md': file('h-zet', 'notes/zettelkasten'),
    'Notes/Slip Box.md': file('h-slip', 'notes/slip-box'),
    'Notes/Antinet.md': file('h-anti', 'notes/antinet'),
  },
  links: {},
  redirects: [],
}

function makeScan(overrides = {}) {
  const files = {
    ...previous.files,
    'Notes/This is just a test.md': file('new', 'notes/this-is-just-a-test'),
  }
  return {
    snapshot: {
      version: 1,
      id: 'next',
      parent: previous.id,
      createdAt: 1_700_000_000_000,
      generator: { plugin: 'open-publish', version: '0.1.0' },
      site,
      files,
      links: {},
      redirects: [],
    },
    previous,
    currentEtag: 'etag-prev',
    isFirstPublish: false,
    added: [],
    changed: ['Notes/This is just a test.md'],
    unchanged: [
      'Notes/Café Résumé.md',
      'Notes/Home.md',
      'Notes/Luhmann.md',
      'Notes/Zettelkasten.md',
      'Notes/Slip Box.md',
      'Notes/Antinet.md',
      'attachments/diagram.png',
    ],
    removed: [],
    renames: [],
    autoIncluded: new Set(),
    linkedButUnpublished: [],
    blockers: [],
    warnings: [],
    totalBytes: 73,
    ...overrides,
  }
}

async function openWindow(options = {}) {
  const { scan = makeScan(), ...rest } = options
  const plugin = fakePlugin({ scan: async () => scan, ...rest })
  const modal = new PublishModal({}, plugin)
  modal.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { modal, plugin, root: modal.contentEl, scan }
}

const ticks = (root) => findAll(root, byClass('op-tree-tick'))
const rowFor = (root, name) =>
  findAll(root, byClass('op-tree-row')).find((row) => find(row, byClass('op-tree-name'))?.textContent === name)
const tickFor = (root, name) => find(rowFor(root, name), byClass('op-tree-tick'))
/** The first button in the footer, whatever it currently says. */
const publishButton = (root) => {
  const actions = findAll(root, byClass('op-progress-actions')).at(-1)
  return actions && findAll(actions, (node) => node.tagName === 'BUTTON')[0]
}
const reviewing = (root) =>
  findAll(root, (node) => node.tagName === 'BUTTON').some((node) => node.textContent.startsWith('Publish '))
const buttons = (root, label) =>
  findAll(root, (node) => node.tagName === 'BUTTON').filter((node) => node.textContent === label)
const section = (root, title) =>
  findAll(root, byClass('op-section')).find((node) => find(node, byClass('op-section-title'))?.textContent === title)
const openSection = (root, title) => click(find(section(root, title), byClass('op-section-header')))

test('the window opens on a review, with only the actual change ticked', async () => {
  const { root } = await openWindow()
  assert.match(root.textContent, /1 changed/)
  assert.equal(publishButton(root).textContent, 'Publish 1 change')
  assert.equal(tickFor(root, 'This is just a test').checked, true)

  // Already-published files are behind a collapsed section, and none of them
  // are ticked. That is the whole fix: the screen stops implying a re-upload.
  const alreadyPublished = section(root, 'Already published — select to unpublish')
  assert.ok(alreadyPublished, 'the section exists')
  assert.match(find(alreadyPublished, byClass('op-section-count')).textContent, /0 of 7 selected/)
  assert.equal(findAll(alreadyPublished, byClass('op-tree-row')).filter(visible).length, 0, 'and it starts closed')

  openSection(root, 'Already published — select to unpublish')
  assert.equal(
    ticks(alreadyPublished).some((tick) => tick.checked),
    false,
  )
})

test('a checkbox stays where the click put it', async () => {
  // The bug this exists for: the browser flips a checkbox before the listeners
  // run and puts it back afterwards if the listener called preventDefault, so
  // anything the listener assigned to `checked` was silently reverted. The file
  // looked untouched while its parent folder lit up.
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  const tick = tickFor(root, 'Home')
  assert.equal(tick.checked, false)

  click(tick)
  assert.equal(tick.checked, true, 'the box the user clicked is the box that changed')

  click(tick)
  assert.equal(tick.checked, false, 'and it clicks back off again')
})

test('ticking a file marks its folder as partly ticked, not fully', async () => {
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  click(tickFor(root, 'Home'))

  const folder = findAll(root, byClass('op-tree-row'))
    .filter((row) => find(row, byClass('op-tree-name'))?.textContent === 'Notes')
    .map((row) => find(row, byClass('op-tree-tick')))
    .at(-1)
  assert.equal(folder.indeterminate, true, 'some of its notes, not all of them')
  assert.equal(folder.checked, false)
})

test('ticking a folder ticks every file under it', async () => {
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  const folder = tickFor(root, 'attachments')
  click(folder)

  assert.equal(folder.checked, true)
  assert.equal(folder.indeterminate, false)
  assert.equal(tickFor(root, 'diagram').checked, true)
})

test('the counts and the button follow the ticks', async () => {
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')

  click(tickFor(root, 'This is just a test'))
  assert.equal(publishButton(root).disabled, true, 'nothing ticked, nothing to publish')

  click(tickFor(root, 'Home'))
  assert.equal(publishButton(root).textContent, 'Publish 1 removal')

  click(tickFor(root, 'This is just a test'))
  assert.equal(publishButton(root).textContent, 'Publish 1 change and 1 removal')
})

test('the Publish button starts a publish', async () => {
  const { root, plugin } = await openWindow()
  click(publishButton(root))

  assert.equal(plugin.calls.publishes.length, 1, 'the button did something')
  const { selection, summary } = plugin.calls.publishes[0]
  assert.equal(summary.updates, 1)
  assert.equal(summary.removals, 0)
  assert.equal(selection.include.has('Notes/This is just a test.md'), true)
  assert.equal(selection.include.has('Notes/Home.md'), true, 'the rest of the site stays on it')
  assert.equal(selection.keepPrevious.size, 0)
})

test('the window switches to progress once publishing starts', async () => {
  const { root, plugin } = await openWindow()
  click(publishButton(root))
  assert.equal(plugin.calls.publishes.length, 1)
  assert.match(root.textContent, /Publishing/)
  assert.equal(reviewing(root), false, 'the review is gone')
  assert.ok(
    findAll(root, (node) => node.tagName === 'BUTTON').some((node) => node.textContent === 'Cancel'),
    'and cancel is offered while there is still something to cancel',
  )
})

test('unticking a changed file holds it at its published version', async () => {
  const { root, plugin } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  click(tickFor(root, 'This is just a test'))
  click(tickFor(root, 'Home'))
  click(publishButton(root))

  const { selection } = plugin.calls.publishes[0]
  assert.equal(selection.keepPrevious.has('Notes/This is just a test.md'), true)
  assert.equal(selection.include.has('Notes/This is just a test.md'), false)
  assert.equal(selection.include.has('Notes/Home.md'), false, 'the ticked one comes off the site')
})

test('closing the window does not cancel the publish', async () => {
  const { root, modal, plugin } = await openWindow()
  click(publishButton(root))
  const session = plugin.session
  modal.close()
  assert.equal(session.isRunning(), true)
  assert.equal(session.current().cancellable, true)
})

test('reopening mid-run shows the run rather than rescanning', async () => {
  let scans = 0
  const scan = makeScan()
  const plugin = fakePlugin({
    scan: async () => {
      scans++
      return scan
    },
  })
  const first = new PublishModal({}, plugin)
  first.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  click(publishButton(first.contentEl))
  first.close()
  assert.equal(scans, 1)

  const second = new PublishModal({}, plugin)
  second.open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(scans, 1, 'no rescan')
  assert.match(second.contentEl.textContent, /Publishing/)
})

test('a big removal asks before it takes pages down', async () => {
  const { root, plugin } = await openWindow()
  click(buttons(section(root, 'Already published — select to unpublish'), 'All')[0])
  assert.equal(publishButton(root).textContent, 'Publish 1 change and 7 removals')

  click(publishButton(root))
  assert.equal(plugin.calls.publishes.length, 0, 'the first click only asks')
  assert.match(publishButton(root).textContent, /This takes 7 pages off your site\. Publish anyway\?/)

  click(publishButton(root))
  assert.equal(plugin.calls.publishes.length, 1, 'the second click goes ahead')
})

test('a small removal publishes on the first click', async () => {
  const { root, plugin } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  click(tickFor(root, 'Home'))
  click(publishButton(root))
  assert.equal(plugin.calls.publishes.length, 1, 'one removal is not worth a confirmation')
})

test('any tick withdraws the question', async () => {
  const { root, plugin } = await openWindow()
  click(buttons(section(root, 'Already published — select to unpublish'), 'All')[0])
  click(publishButton(root))
  assert.match(publishButton(root).textContent, /Publish anyway\?/)

  openSection(root, 'Already published — select to unpublish')
  click(tickFor(root, 'Home'))
  assert.equal(/Publish anyway\?/.test(publishButton(root).textContent), false, 'the number moved, so the question went')

  click(publishButton(root))
  assert.equal(plugin.calls.publishes.length, 0, 'and it has to be asked again')
})

test('nothing to publish says so instead of offering a dead button', async () => {
  const scan = makeScan({ changed: [], unchanged: Object.keys(previous.files) })
  scan.snapshot.files = previous.files
  const { root } = await openWindow({ scan })
  assert.match(root.textContent, /Nothing to publish/)
  assert.match(root.textContent, /already matches your notes/)
  assert.equal(reviewing(root), false, 'no dead Publish button to click')
  assert.equal(publishButton(root).textContent, 'Close')
})

test('every section that is on screen can be read', async () => {
  const { root } = await openWindow()
  const names = findAll(root, byClass('op-tree-name')).filter(visible).map((node) => node.textContent)
  assert.ok(names.includes('Notes'), 'folders are shown')
  assert.ok(names.includes('This is just a test'), 'and notes lose the .md noise')
})

test('folding a folder hides its files and leaves the folder itself clickable', async () => {
  // The obvious implementation puts the hide-class on the folder's own row too,
  // which takes the twisty with it — a folder you can close and never reopen.
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')

  const folderRow = findAll(root, byClass('op-row-folder')).find(
    (row) => find(row, byClass('op-tree-name')).textContent === 'attachments',
  )
  const twisty = find(folderRow, byClass('op-twisty'))

  assert.equal(visible(rowFor(root, 'diagram')), true)
  click(twisty)
  assert.equal(visible(rowFor(root, 'diagram')), false, 'the files fold away')
  assert.equal(visible(folderRow), true, 'the folder stays put')

  click(twisty)
  assert.equal(visible(rowFor(root, 'diagram')), true, 'and it opens again')
})

test('folding a folder does not tick it', async () => {
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')
  const folderRow = findAll(root, byClass('op-row-folder')).find(
    (row) => find(row, byClass('op-tree-name')).textContent === 'attachments',
  )
  click(find(folderRow, byClass('op-twisty')))
  assert.equal(find(folderRow, byClass('op-tree-tick')).checked, false)
  assert.equal(publishButton(root).textContent, 'Publish 1 change')
})

test('closing a section leaves its header there to reopen it', async () => {
  const { root } = await openWindow()
  const changed = section(root, 'Changed')
  const header = find(changed, byClass('op-section-header'))

  assert.equal(visible(rowFor(root, 'This is just a test')), true)
  click(header)
  assert.equal(visible(rowFor(root, 'This is just a test')), false)
  assert.equal(visible(header), true, 'the header survives')
  assert.match(find(changed, byClass('op-section-count')).textContent, /1 of 1 selected/)

  click(header)
  assert.equal(visible(rowFor(root, 'This is just a test')), true)
})

test('clicking a row anywhere ticks it, and clicking the box does not double back', async () => {
  const { root } = await openWindow()
  openSection(root, 'Already published — select to unpublish')

  // The name is a much bigger target than the box, and people aim at it.
  click(find(rowFor(root, 'Home'), byClass('op-tree-name')))
  assert.equal(tickFor(root, 'Home').checked, true)

  click(tickFor(root, 'Home'))
  assert.equal(tickFor(root, 'Home').checked, false, 'the box toggles once, not twice')
})

test('the window shadows nothing Obsidian already put on Modal', async () => {
  // How the Publish button came to do nothing: a `selection()` method on the
  // subclass, an undocumented `this.selection` field on Modal, and no type
  // error because the field is not in the public typings. The fix was to move
  // the state off the Modal subclass entirely; this keeps it moved.
  // Methods are what get shadowed: they live on the prototype, and an instance
  // field assigned by the base class sits in front of them.
  const { modal } = await openWindow()
  const methods = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(modal)))
  methods.delete('constructor')

  const overridden = new Set(['onOpen', 'onClose'])
  for (const name of MODAL_MEMBERS) {
    if (overridden.has(name)) continue
    assert.equal(methods.has(name), false, `PublishModal.${name} is shadowed by Modal's own ${name}`)
  }
})

test('a pure rename is publishable', async () => {
  // Renames are shown for information and applied whatever the ticks say, so
  // they are filtered out of New and Removed. Forgetting to count them anywhere
  // meant a vault whose only change was a rename reached the review screen with
  // the button greyed out and "no changes" written above a Renamed section.
  const renamed = makeScan({
    changed: [],
    added: ['Notes/Zettelkasten renamed.md'],
    removed: ['Notes/Zettelkasten.md'],
    renames: [{ from: 'Notes/Zettelkasten.md', to: 'Notes/Zettelkasten renamed.md' }],
    unchanged: ['Notes/Café Résumé.md', 'Notes/Home.md'],
  })
  renamed.snapshot.files = {
    ...previous.files,
    'Notes/Zettelkasten renamed.md': previous.files['Notes/Zettelkasten.md'],
  }
  delete renamed.snapshot.files['Notes/Zettelkasten.md']

  const { root, plugin } = await openWindow({ scan: renamed })
  assert.match(root.textContent, /Renamed/, 'the rename is shown')
  assert.equal(publishButton(root).disabled, false, 'and it can be published')
  assert.equal(publishButton(root).textContent, 'Publish 1 change')

  click(publishButton(root))
  const { selection } = plugin.calls.publishes[0]
  assert.equal(selection.include.has('Notes/Zettelkasten renamed.md'), true)
  assert.equal(selection.include.has('Notes/Zettelkasten.md'), false, 'the old path comes off')
})
