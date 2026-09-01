/**
 * The import preview, driven the way a person drives it.
 *
 * The arithmetic is unit tested in `publishimport.test.mjs` and the file format
 * in `publishconfig.test.mjs`. What is only findable here is the wiring: that
 * the headline number is the one a publish would actually produce, that
 * pressing Import writes both lists and nothing else, and that the preview is
 * a preview rather than a second folder editor.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

globalThis.window ??= { open() {}, setTimeout: () => 0, clearTimeout: () => {} }

const { byClass, click, find, findAll } = await import('./dom.mjs')
const { OpenPublishPlugin, PublishImportModal, fakeApp, fakeSettingsPlugin, notices } = await import('./harness.mjs')
const { parsePublishConfig } = await import('../src/core/publishconfig.ts')

const VAULT = {
  folders: ['Notes', 'Notes/Drafts', 'Ideas', 'Archive', 'Archive/2024', '.obsidian'],
  files: [
    'Notes/Luhmann.md',
    'Notes/Zettelkasten.md',
    'Notes/Drafts/Half thought.md',
    'Ideas/WIP.md',
    'Archive/2024/Old.md',
    'Standalone.md',
    '.obsidian/data.json',
  ],
}

/** A real Publish file: a 32-character site id and an obsidian.md shard. */
const publishFile = (fields) =>
  JSON.stringify({ siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad', host: 'publish-01.obsidian.md', ...fields })

function open(raw, { selection = {}, frontmatter = {}, urlStyle = 'clean', lastPublishedAt = null, extraFiles = [] } = {}) {
  const app = fakeApp({ ...VAULT, files: [...VAULT.files, ...extraFiles], frontmatter })
  const plugin = fakeSettingsPlugin(selection, {}, { urlStyle, lastPublishedAt, publishConfig: raw })
  const parsed = parsePublishConfig(raw)
  assert.equal(parsed.ok, true, 'the fixture has to be readable, or the test is about the wrong thing')
  const modal = new PublishImportModal(app, plugin, { config: parsed.config, dropped: parsed.dropped })
  modal.open()
  return { app, plugin, modal }
}

/** Every rule row on screen: its path, what it says on the right, and its warning. */
function rows(modal) {
  return findAll(modal.contentEl, byClass('op-rule-row')).map((row) => ({
    path: find(row, byClass('op-rule-path')).textContent,
    meta: find(row, byClass('op-rule-meta')).textContent,
    warning: row.hasClass('op-rule-dead') ? find(row, byClass('setting-item-description')).textContent : null,
  }))
}

const importButton = (modal) => find(modal.contentEl, (node) => node.tagName === 'BUTTON' && node.hasClass('mod-cta'))
const cancelButton = (modal) =>
  find(modal.contentEl, (node) => node.tagName === 'BUTTON' && node.textContent === 'Cancel')
const warnings = (modal) => findAll(modal.contentEl, byClass('op-notice-warning')).map((node) => node.textContent)

const URL_TOGGLE = 'Keep the URLs Obsidian Publish gave this site'
const nameOf = (row) => find(row, byClass('setting-item-name'))?.textContent ?? ''
const checkboxIn = (row) => find(row, (node) => node.tagName === 'INPUT' && node.type === 'checkbox')
const settingWithCheckbox = (modal) => findAll(modal.contentEl, byClass('setting-item')).filter(checkboxIn)

/** The legacy-URL toggle, found by its row rather than by being the first box on screen. */
const toggle = (modal) => {
  const row = settingWithCheckbox(modal).find((item) => nameOf(item) === URL_TOGGLE)
  return row ? checkboxIn(row) : null
}

/** Every note offered as one Publish may have served on its own. */
const candidates = (modal) =>
  settingWithCheckbox(modal)
    .filter((item) => nameOf(item) !== URL_TOGGLE)
    .map((item) => ({
      path: nameOf(item),
      permalink: find(item, byClass('setting-item-description')).textContent,
      ticked: checkboxIn(item).checked,
    }))

/** Ticks or unticks one offered note, by path. The screen redraws underneath. */
const tick = (modal, path) => {
  const row = settingWithCheckbox(modal).find((item) => nameOf(item) === path)
  assert.ok(row, `no offer row for ${path}`)
  click(checkboxIn(row))
}

/**
 * The three root notes the live site published individually, each carrying the
 * permalink Publish served it at, none of them inside any folder in publish.json.
 */
const REAL_MIGRATION = {
  extraFiles: ['Welcome.md', 'Now.md', 'Start here.md'],
  frontmatter: {
    'Welcome.md': { permalink: 'welcome' },
    'Now.md': { permalink: 'now' },
    'Start here.md': { permalink: 'start' },
  },
}

test('every folder is listed with what it would publish, and what importing does to it', () => {
  const { modal } = open(publishFile({ included: ['Notes', 'Ideas'], excluded: ['Notes/Drafts'] }), {
    selection: { includes: ['Ideas', 'Archive'] },
  })

  assert.deepEqual(rows(modal), [
    { path: 'Notes', meta: '2 notes · added', warning: null },
    { path: 'Ideas', meta: '1 note · already listed', warning: null },
    { path: 'Archive', meta: '1 note · no longer published', warning: null },
    { path: 'Notes/Drafts', meta: '1 note · added', warning: null },
  ])
})

test('a folder renamed since Publish last saved says so, and one naming a file does not', () => {
  const { modal } = open(publishFile({ included: ['Old name', 'Standalone.md'] }))
  const [renamed, file] = rows(modal)

  assert.equal(renamed.meta, '0 notes · added')
  assert.match(renamed.warning, /no longer exists/)
  // `matchesFolderRule` matches an exact file path too, so calling this dead
  // would be plainly wrong.
  assert.equal(file.meta, '1 note · added')
  assert.equal(file.warning, null)
})

test('the headline counts what a publish would produce, frontmatter and all', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), {
    frontmatter: { 'Notes/Luhmann.md': { publish: false } },
  })

  // Notes holds three notes, and one of them says publish: false, which wins
  // over any folder rule. The row beside it still reads 3, because that is what
  // the rule selects, so the divergence is explained rather than left to look
  // like an arithmetic bug.
  assert.match(modal.contentEl.textContent, /Importing them publishes 2 notes instead of nothing\./)
  assert.equal(rows(modal)[0].meta, '3 notes · added')
  assert.match(modal.contentEl.textContent, /Some notes set publish: in their frontmatter/)
})

test('the rows and the headline agree when no note overrides them', () => {
  // Dropping a rule that names nothing changes no number at all.
  const { modal } = open(publishFile({ included: ['Notes'] }), { selection: { includes: ['Notes', 'Old name'] } })
  assert.match(modal.contentEl.textContent, /Importing them publishes 3 notes, as much as now\./)
  assert.doesNotMatch(modal.contentEl.textContent, /frontmatter, which wins/)
})

test('an attachment in a published folder is counted as an attachment, not as a note', () => {
  // The shape of a real migrating vault: a PDF sitting in an attachments
  // folder inside a published one. Saying "4 notes" here would not match the
  // number Obsidian Publish shows the same person.
  const { modal } = open(publishFile({ included: ['Notes'] }), {
    extraFiles: ['Notes/attachments/Guide.pdf'],
  })

  assert.match(modal.contentEl.textContent, /publishes 3 notes and 1 attachment instead of nothing\./)
  assert.equal(importButton(modal).textContent, 'Import 1 folder (3 notes and 1 attachment)')
  assert.doesNotMatch(modal.contentEl.textContent, /frontmatter, which wins/, 'the totals still agree')
})

test('Import writes both lists, saves once, and says what it did', () => {
  notices.length = 0
  const { modal, plugin } = open(publishFile({ included: ['Notes', 'Ideas'], excluded: ['Notes/Drafts'] }), {
    selection: { includes: ['Archive'], excludes: ['Ideas'] },
  })

  // Two notes, not three: this vault's own exclude on Ideas is kept, and it
  // shadows one of the folders being imported.
  assert.equal(importButton(modal).textContent, 'Import 2 folders (2 notes)')
  click(importButton(modal))

  assert.deepEqual(plugin.settings.selection.includes, ['Notes', 'Ideas'], 'includes are replaced')
  assert.deepEqual(plugin.settings.selection.excludes, ['Ideas', 'Notes/Drafts'], 'excludes are only added to')
  assert.equal(plugin.saves, 1)
  assert.equal(modal.isOpen, false)
  assert.match(notices.at(-1), /Imported 2 folders from Obsidian Publish/)
  assert.match(notices.at(-1), /added to your excluded list/)
})

test('Cancel writes nothing at all', () => {
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }), { selection: { includes: ['Archive'] } })
  click(cancelButton(modal))

  assert.deepEqual(plugin.settings.selection.includes, ['Archive'])
  assert.equal(plugin.saves, 0)
  assert.equal(modal.isOpen, false)
})

test('per-file choices and the embed setting are not touched', () => {
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }), {
    selection: { explicit: { 'Archive/2024/Old.md': true }, autoIncludeEmbeds: false },
  })
  click(importButton(modal))

  assert.deepEqual(plugin.settings.selection.explicit, { 'Archive/2024/Old.md': true })
  assert.equal(plugin.settings.selection.autoIncludeEmbeds, false)
})

test('the URL offer is pre-ticked, and importing applies it', () => {
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }))

  assert.match(modal.contentEl.textContent, /puts a redirect at every old address/)
  assert.equal(toggle(modal).checked, true, 'wrongly off costs every inbound link, permanently')

  click(importButton(modal))
  assert.equal(plugin.settings.urlStyle, 'clean-with-redirects')
})

test('unticking it leaves the URL setting alone', () => {
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }))
  click(toggle(modal))
  click(importButton(modal))

  assert.equal(plugin.settings.urlStyle, 'clean')
})

test('a vault that already chose the redirects is not asked again', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), { urlStyle: 'clean-with-redirects' })
  assert.equal(toggle(modal), null, 'a deliberate earlier choice is never re-asked or overwritten')
})

test('a hand-made publish.json is imported, but the URL offer is not made', () => {
  // The offer turns on evidence that this really was a Publish site. Importing
  // never does: the folder list is usable either way.
  const { modal, plugin } = open(JSON.stringify({ included: ['Notes'] }))
  assert.equal(toggle(modal), null)

  click(importButton(modal))
  assert.deepEqual(plugin.settings.selection.includes, ['Notes'])
  assert.equal(plugin.settings.urlStyle, 'clean')
})

test('a live site is told which notes come off it, and only when some do', () => {
  const losing = open(publishFile({ included: ['Notes'] }), {
    selection: { includes: ['Notes', 'Archive'] },
    lastPublishedAt: 1_700_000_000_000,
  })
  assert.ok(warnings(losing.modal).some((said) => /taken off it on the next publish/.test(said)))

  const adding = open(publishFile({ included: ['Notes', 'Archive'] }), {
    selection: { includes: ['Notes'] },
    lastPublishedAt: 1_700_000_000_000,
  })
  assert.equal(warnings(adding.modal).some((said) => /taken off it/.test(said)), false)

  const unpublished = open(publishFile({ included: ['Notes'] }), { selection: { includes: ['Notes', 'Archive'] } })
  assert.equal(warnings(unpublished.modal).some((said) => /taken off it/.test(said)), false)
})

test('a blank entry never reaches the preview, and is reported for what it would have done', () => {
  const { modal } = open(publishFile({ included: ['', 'Notes'] }))

  assert.deepEqual(
    rows(modal).map((row) => row.path),
    ['Notes'],
    'a blank rule would have published the whole vault',
  )
  assert.match(warnings(modal)[0], /matches every note in the vault/)
})

test('a configuration with no folder filters offers nothing, and says which case it is', () => {
  const { modal } = open(publishFile({}))

  assert.match(modal.contentEl.textContent, /records no folder filters/)
  assert.equal(importButton(modal).disabled, true)
  assert.match(modal.contentEl.textContent, /There are no folders to import\./)
  assert.equal(findAll(modal.contentEl, byClass('op-rule-row')).length, 0)
})

test('a site picked note by note says so, rather than appearing broken', () => {
  const { modal } = open(publishFile({ included: [], excluded: [] }))

  assert.match(modal.contentEl.textContent, /selects notes individually rather than by folder/)
  assert.match(modal.contentEl.textContent, /live on Obsidian's servers rather than in your vault/)
  assert.match(modal.contentEl.textContent, /this plugin does not talk to Obsidian, so it cannot see them/)
  assert.equal(importButton(modal).disabled, true)
})

test('a configuration matching the vault disables Import and says why', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), { selection: { includes: ['Notes'] } })

  assert.equal(importButton(modal).disabled, true)
  assert.match(modal.contentEl.textContent, /Your folders already match this configuration\./)
})

test('the excludes-are-kept promise is on screen wherever there are excludes', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), { selection: { excludes: ['Notes/Drafts'] } })
  assert.match(modal.contentEl.textContent, /An excluded folder can only ever publish less/)
})

test('nothing in the preview can be edited: no remove control and no picker', () => {
  const { modal } = open(publishFile({ included: ['Notes', 'Ideas'], excluded: ['Notes/Drafts'] }), {
    selection: { includes: ['Archive'] },
  })

  assert.equal(findAll(modal.contentEl, byClass('op-rule-remove')).length, 0, 'a preview is not a second rule editor')
  assert.equal(findAll(modal.contentEl, byClass('op-rule-add')).length, 0)
  assert.equal(
    findAll(modal.contentEl, (node) => node.getAttr('placeholder') === 'Add a folder…').length,
    0,
    'this would be someone wiring renderFolderList in by mistake',
  )
})

// --- notes Publish may have published one at a time ------------------------

test('the notes a permalink points at are offered, unticked, each with its permalink', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), REAL_MIGRATION)

  assert.deepEqual(candidates(modal), [
    { path: 'Now.md', permalink: 'now', ticked: false },
    { path: 'Start here.md', permalink: 'start', ticked: false },
    { path: 'Welcome.md', permalink: 'welcome', ticked: false },
  ])
  // Wrongly on here publishes a private note, which is why this is the one
  // offer on the screen whose default publishes less.
  assert.match(modal.contentEl.textContent, /Notes that may have been published individually/)
  assert.match(modal.contentEl.textContent, /Tick any that belong on your site/)
})

test('the offer says what it cannot see, so nobody reads it as the whole list', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), REAL_MIGRATION)
  assert.match(modal.contentEl.textContent, /without a permalink cannot be found this way/)
  assert.match(modal.contentEl.textContent, /Compare against your live site/)
})

test('ticking one moves the headline and the button, because they say what Import will do', () => {
  const { modal } = open(publishFile({ included: ['Notes'] }), REAL_MIGRATION)
  assert.match(modal.contentEl.textContent, /publishes 3 notes instead of nothing\./)
  assert.equal(importButton(modal).textContent, 'Import 1 folder (3 notes)')

  tick(modal, 'Welcome.md')

  assert.match(modal.contentEl.textContent, /publishes 4 notes instead of nothing\./)
  assert.equal(importButton(modal).textContent, 'Import 1 folder (4 notes)')
  assert.deepEqual(
    candidates(modal).filter((candidate) => candidate.ticked).map((candidate) => candidate.path),
    ['Welcome.md'],
    'the tick survives the redraw it causes',
  )
})

test('Import writes the ticked notes, and leaves every other per-file choice alone', () => {
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }), {
    ...REAL_MIGRATION,
    selection: { explicit: { 'Archive/2024/Old.md': true } },
  })

  tick(modal, 'Welcome.md')
  tick(modal, 'Now.md')
  tick(modal, 'Now.md')
  click(importButton(modal))

  // An unticked candidate is "no opinion", never a stored `false`: that would
  // invent a refusal nobody made and outrank any folder rule added later.
  assert.deepEqual(plugin.settings.selection.explicit, {
    'Archive/2024/Old.md': true,
    'Welcome.md': true,
  })
  assert.deepEqual(plugin.settings.selection.includes, ['Notes'], 'and the folders are still imported')
  assert.equal(plugin.saves, 1)
})

test('a site that selected every note by hand is no longer a dead end', () => {
  const { modal, plugin } = open(publishFile({ included: [], excluded: [] }), {
    ...REAL_MIGRATION,
    selection: { includes: ['Archive'] },
  })

  assert.equal(candidates(modal).length, 3, 'the empty plan is the case this matters most in')
  assert.equal(importButton(modal).disabled, true)
  assert.match(modal.contentEl.textContent, /There are no folders to import\./)

  tick(modal, 'Welcome.md')
  assert.equal(importButton(modal).disabled, false)
  assert.equal(importButton(modal).textContent, 'Import 1 note')

  click(importButton(modal))
  assert.deepEqual(plugin.settings.selection.explicit, { 'Welcome.md': true })
  // Nothing to import must never mean everything to remove: an empty include
  // list is not an instruction to delete the rules this vault already has.
  assert.deepEqual(plugin.settings.selection.includes, ['Archive'])
  assert.match(notices.at(-1), /1 note was added individually/)
})

test('a note a folder already publishes, or one that refuses, is never offered', () => {
  const { modal } = open(publishFile({ included: ['Notes'], excluded: ['Ideas'] }), {
    frontmatter: {
      // Covered by the imported folder: ticking it would do nothing.
      'Notes/Luhmann.md': { permalink: 'luhmann' },
      // An explicit refusal, which this must never offer to overturn.
      'Standalone.md': { permalink: 'standalone', publish: false },
      // Held back by an exclude, which resolves before every include.
      'Ideas/WIP.md': { permalink: 'wip' },
    },
  })

  assert.deepEqual(candidates(modal), [])
})

test('past the cap the rest are named rather than listed', () => {
  const many = Array.from({ length: 30 }, (_, index) => `Root/Note ${String(index).padStart(2, '0')}.md`)
  const { modal } = open(publishFile({ included: ['Notes'] }), {
    extraFiles: many,
    frontmatter: Object.fromEntries(many.map((path, index) => [path, { permalink: `p${index}` }])),
  })

  assert.equal(candidates(modal).length, 25)
  assert.match(modal.contentEl.textContent, /5 more notes carry a permalink and are not listed\./)
})

test('unticking the redirects survives ticking a note', () => {
  // The redraw must not re-arm an answer already given. Wrongly on there is
  // cheap; silently overriding a deliberate choice is not.
  const { modal, plugin } = open(publishFile({ included: ['Notes'] }), REAL_MIGRATION)
  click(toggle(modal))
  tick(modal, 'Welcome.md')

  assert.equal(toggle(modal).checked, false)
  click(importButton(modal))
  assert.equal(plugin.settings.urlStyle, 'clean')
})

// --- reading the file ------------------------------------------------------

/**
 * `onload` is never called here: it registers commands and a status bar, and
 * neither has anything to do with finding one file.
 */
function plugin(app) {
  const instance = new OpenPublishPlugin()
  instance.app = app
  return instance
}

test('the file is read from wherever this vault keeps its configuration', async () => {
  const raw = publishFile({ included: ['Notes'] })
  const moved = plugin(fakeApp({ configDir: 'my-config', configFiles: { 'my-config/publish.json': raw } }))
  // Hardcoding `.obsidian` would bite exactly the people this feature is for:
  // anyone who moved their config directory has been at this a long time, which
  // is the population that paid for Publish for years.
  assert.equal(await moved.readObsidianPublishConfig(), raw)

  const usual = plugin(fakeApp({ configFiles: { '.obsidian/publish.json': raw } }))
  assert.equal(await usual.readObsidianPublishConfig(), raw)
})

test('no file and an unreadable file give the same answer, because the advice is the same', async () => {
  const absent = plugin(fakeApp({}))
  assert.equal(await absent.readObsidianPublishConfig(), null, 'absence is an ordinary state, never an error')

  const unreadable = plugin(fakeApp({ configFiles: { '.obsidian/publish.json': '{}' } }))
  unreadable.app.vault.adapter.read = async () => {
    throw new Error('EACCES')
  }
  assert.equal(await unreadable.readObsidianPublishConfig(), null)
})

test('nothing is offered until the file has been found', () => {
  assert.equal(plugin(fakeApp({})).hasObsidianPublishConfig(), false)
})
