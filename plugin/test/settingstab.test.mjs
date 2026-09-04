/**
 * The settings tab, as the tree it now returns.
 *
 * Most of what used to be asserted against a rendered DOM is plain data here:
 * a description is a string on a definition, and a conditional row is a
 * `visible()` that answers true or false rather than a CSS class inferred from
 * an ancestor. What still needs a DOM is what the plugin still draws itself:
 * the `render:` rows, and the storage and build forms behind their `page()`
 * factories. The stub has no definitions-to-DOM renderer on purpose, so
 * nothing below is testing a second copy of Obsidian.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OpenPublishSettingTab,
  Setting,
  SettingGroup,
  fakeApp,
  fakeStoragePlugin,
  secretFields,
} from './harness.mjs'
import { byClass, click, dispatch, el, find, findAll, visible } from './dom.mjs'

const R2_ENDPOINT = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com'
const ROLLBACK_HEADLINE = 'Your site is showing an older version.'

function open(stored = {}, appOptions = {}) {
  const app = fakeApp({ files: ['Notes/Home.md'], folders: ['Notes'], ...appOptions })
  const plugin = fakeStoragePlugin({ stored })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.update()
  return { tab, plugin }
}

/** One of the eight landing entries. */
const entry = (tab, name) => tab.settingItems.find((item) => item.name === name)

/** Every definition anywhere in the tree, parents before children. */
function* walk(nodes) {
  for (const node of nodes ?? []) {
    yield node
    yield* walk(node.items)
  }
}

const defNamed = (tab, name) => [...walk(tab.settingItems)].find((def) => def.name === name)
const controlOf = (tab, name) => defNamed(tab, name)?.control ?? null
const itemNames = (node) => (node.items ?? []).map((item) => item.name)

/**
 * A `render:` row, drawn.
 *
 * The framework sets the name and description from the definition and then
 * hands the row to the callback, so this does the same and returns the element
 * the existing readers below already understand.
 */
function drawn(def) {
  const root = el()
  const setting = new Setting(root).setName(def.name)
  if (typeof def.desc === 'string') setting.setDesc(def.desc)
  def.render(setting, new SettingGroup(root))
  return setting.settingEl
}

/** A sub-page rendered by its own factory: the storage and build forms. */
function pageRoot(tab, name) {
  const page = entry(tab, name).page()
  page.display()
  return page.containerEl
}

const rowNamed = (root, name) =>
  find(root, (node) => node.hasClass('setting-item') && find(node, byClass('setting-item-name'))?.textContent === name)

const inputIn = (row) => find(row, (node) => node.tagName === 'INPUT' || node.tagName === 'SELECT')
const descOf = (row) => find(row, byClass('setting-item-description'))?.textContent ?? ''
const errorOf = (row) => find(row, byClass('setting-item-error'))?.textContent ?? null
const buttonIn = (row) => find(row, (node) => node.tagName === 'BUTTON')

/**
 * The keychain field inside a row, found by where it was drawn.
 *
 * `SecretComponent` is built by the caller rather than by the row, so unlike
 * every other component here there is no `addX` call to intercept. The stub
 * records each one it constructs; this picks the one whose element sits inside
 * the row asked for.
 */
const secretIn = (row) =>
  secretFields.findLast((field) => {
    for (let node = field.containerEl; node; node = node.parentElement) if (node === row) return true
    return false
  }) ?? null

// --- the landing page -----------------------------------------------------

test('the tab opens on eight entries, in order, and none of them is a heading', () => {
  const { tab } = open()
  assert.deepEqual(
    tab.settingItems.map((item) => [item.name, item.type ?? 'setting']),
    [
      ['Setup', 'setting'],
      ['Storage', 'page'],
      ['Site build', 'page'],
      ['What gets published', 'page'],
      ['Site options', 'page'],
      ['Appearance', 'page'],
      ['Maintenance', 'page'],
      ['About your credentials', 'setting'],
    ],
    'the tab title already names the plugin, so nothing here carries a heading of its own',
  )
})

test('every page entry says what is inside it without being opened', () => {
  const { tab } = open()
  assert.equal(entry(tab, 'Storage').displayValue(), 'Cloudflare R2')
  assert.equal(entry(tab, 'Site build').displayValue(), 'Cloudflare Pages')
  assert.match(entry(tab, 'What gets published').displayValue(), /No folder rules yet/)
  assert.equal(entry(tab, 'Site options').displayValue(), 'My Notes')
  assert.equal(entry(tab, 'Appearance').displayValue(), '10 of 12 on')
  assert.equal(entry(tab, 'Maintenance').displayValue(), 'Nothing published yet')
})

test('a key prefix is part of where storage points, so the entry names it too', () => {
  const { tab } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'b', prefix: 'notes' } })
  assert.equal(entry(tab, 'Storage').displayValue(), 'Cloudflare R2 · notes')
})

test('the Appearance count follows the toggles it is counting', () => {
  const { tab } = open({ site: { showGraph: false, showTags: false, strictLineBreaks: true } })
  assert.equal(entry(tab, 'Appearance').displayValue(), '9 of 12 on')
})

test('the setup guide is the first thing on the screen, and opens the wizard', () => {
  const { tab } = open()
  const row = drawn(entry(tab, 'Setup'))
  assert.equal(buttonIn(row).textContent, 'Open setup guide')
  assert.ok(buttonIn(row).hasClass('mod-cta'), 'the one call to action on the page')
})

// --- appearance and the navigation manager --------------------------------

test('the navigation manager sits under the toggle it depends on, and reports what it holds', () => {
  const { tab } = open()
  const names = itemNames(entry(tab, 'Appearance'))
  assert.equal(
    names.indexOf('Customize navigation'),
    names.indexOf('Navigation') + 1,
    'an arrangement of a sidebar that is switched off is a control with nothing to control',
  )
  assert.match(defNamed(tab, 'Customize navigation').desc, /Folders first, then notes, alphabetically/)

  const arranged = open({ site: { nav: { order: ['A.md', 'B.md'], hidden: ['C.md'] } } })
  const summary = defNamed(arranged.tab, 'Customize navigation').desc
  assert.match(summary, /2 arranged by hand, 1 hidden/)
  assert.match(summary, /still published and still reachable/)
})

test('with navigation switched off there is nothing to arrange, and the row says so', () => {
  const { tab } = open({ site: { showNavigation: false } })
  const def = defNamed(tab, 'Customize navigation')
  assert.match(def.desc, /Turn navigation on/)
  assert.equal(buttonIn(drawn(def)).disabled, true)
})

test('turning navigation off rewrites the row below it, rather than leaving it stale', async () => {
  const { tab } = open()
  assert.match(defNamed(tab, 'Customize navigation').desc, /Folders first/)

  // A description cannot be a function, so this is the one thing that keeps
  // the row honest: the key rebuilds the tree instead of only repainting it.
  await tab.setControlValue('site.showNavigation', false)
  assert.match(defNamed(tab, 'Customize navigation').desc, /Turn navigation on/)
  assert.equal(buttonIn(drawn(defNamed(tab, 'Customize navigation'))).disabled, true)
})

test('an arrangement large enough to weigh on every page is flagged in settings too', () => {
  const order = Array.from({ length: 500 }, (unused, index) => `Note ${index}.md`)
  const { tab } = open({ site: { nav: { order, hidden: [] } } })
  assert.match(errorOf(drawn(defNamed(tab, 'Customize navigation'))) ?? '', /500 pages are arranged by hand/)
})

test('every appearance toggle writes the site option it is named for', async () => {
  const { tab, plugin } = open()
  assert.equal(controlOf(tab, 'Backlinks').key, 'site.showBacklinks')
  await tab.setControlValue('site.showBacklinks', false)
  assert.equal(plugin.settings.site.showBacklinks, false)
  assert.equal(plugin.calls.saves, 1, 'a toggle saves the moment it is flipped')
})

test('the newest appearance toggles have a control, and it writes', async () => {
  // `APPEARANCE` is keyed by `SiteToggleKey`, so an option added without an
  // entry there fails to compile. What that cannot check is that the row it
  // generates is wired to the option it is named for, which is the difference
  // between a control and a label.
  const { tab, plugin } = open()
  for (const [label, key] of [
    ['Hover previews', 'showHoverPreview'],
    ['Inline title', 'showInlineTitle'],
  ]) {
    assert.equal(controlOf(tab, label)?.key, `site.${key}`, `no control for ${key}`)
    assert.equal(plugin.settings.site[key], true, 'both default on, which is the site every vault already has')
    await tab.setControlValue(`site.${key}`, false)
    assert.equal(plugin.settings.site[key], false)
  }
})

// --- site options ---------------------------------------------------------

test('the analytics ID field hides itself when no provider is chosen', () => {
  const { tab } = open()
  assert.equal(defNamed(tab, 'Tracking ID').visible(), false, 'nothing to type an ID into until a provider is picked')

  const { tab: withProvider } = open({ site: { analytics: { provider: 'plausible', id: 'notes.example.com' } } })
  const shown = defNamed(withProvider, 'Tracking ID')
  assert.equal(shown.visible(), true)
  assert.match(shown.desc, /Plausible domain/)
})

test('the analytics provider is declared above the field it governs', () => {
  const { tab } = open()
  const analytics = (entry(tab, 'Site options').items ?? []).find((item) => item.heading === 'Analytics')
  assert.deepEqual(itemNames(analytics), ['Provider', 'Tracking ID'], 'declaration order is render order')
})

test('picking a provider brings its own hint with it, rather than the last one', async () => {
  const { tab, plugin } = open()
  assert.equal(controlOf(tab, 'Provider').key, 'site.analytics.provider')
  await tab.setControlValue('site.analytics.provider', 'umami')
  assert.equal(plugin.settings.site.analytics.provider, 'umami')
  assert.match(defNamed(tab, 'Tracking ID').desc, /Umami website ID/)
  assert.equal(defNamed(tab, 'Tracking ID').visible(), true)
})

test('picking a right-to-left language sets the direction with it, in one step', async () => {
  // The other of the two places `dir` is ever written. If this one drifted, a
  // Persian vault would publish `lang="fa-IR" dir="ltr"` until the next load.
  const { tab, plugin } = open()
  assert.equal(controlOf(tab, 'Language').key, 'site.locale')
  assert.equal(tab.getControlValue('site.locale'), 'en-US')

  await tab.setControlValue('site.locale', 'fa-IR')
  assert.equal(plugin.settings.site.locale, 'fa-IR')
  assert.equal(plugin.settings.site.dir, 'rtl')

  await tab.setControlValue('site.locale', 'de-DE')
  assert.equal(plugin.settings.site.dir, 'ltr', 'and back again, rather than sticking')
})

test('the homepage says which of its three states it is in', () => {
  const { tab } = open()
  assert.match(descOf(drawn(defNamed(tab, 'Homepage'))), /simple index page will be generated/)

  const { tab: chosen } = open({ site: { homepage: 'Notes/Home.md' } })
  const row = drawn(defNamed(chosen, 'Homepage'))
  assert.match(descOf(row), /It has to be a published note/)
  assert.equal(errorOf(row), null)

  const { tab: gone } = open({ site: { homepage: 'Notes/Missing.md' } })
  assert.match(errorOf(drawn(defNamed(gone, 'Homepage'))), /no longer exists/)
})

test('a homepage that exists but is not published is said out loud', () => {
  const app = fakeApp({ files: ['Notes/Home.md'], folders: ['Notes'] })
  const plugin = fakeStoragePlugin({ stored: { site: { homepage: 'Notes/Home.md' } }, isNotePublished: () => false })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.update()
  assert.match(errorOf(drawn(defNamed(tab, 'Homepage'))), /generated index page instead/)
})

test('the Site URLs choice is offered under Site options and saved when picked', async () => {
  const { tab, plugin } = open()
  const def = defNamed(tab, 'Site URLs')
  assert.ok(def, 'the row is there')
  assert.match(def.desc, /publish\.obsidian\.md/, 'the one condition it cannot check for you is stated')
  assert.ok(itemNames(entry(tab, 'Site options')).includes('Site URLs'))

  assert.equal(def.control.key, 'urlStyle')
  assert.equal(tab.getControlValue('urlStyle'), 'clean')
  await tab.setControlValue('urlStyle', 'clean-with-redirects')
  assert.equal(plugin.settings.urlStyle, 'clean-with-redirects')
})

test('the credentials note is about whatever is actually stored', () => {
  const { tab: keys } = open({ destination: { endpoint: R2_ENDPOINT, bucket: 'b' } })
  const keyNote = entry(keys, 'About your credentials').desc
  assert.match(keyNote, /these keys/i)
  assert.match(keyNote, /do not travel with your notes/, 'the half of the old sentence this change made false')

  const { tab: token } = open({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  })
  const note = entry(token, 'About your credentials').desc
  assert.match(note, /this token/i)
  assert.match(note, /not encryption/, 'the one claim this must never make')
  // The claim that survived the move, and the one people care about. Obsidian's
  // keychain is one namespace on the same `app` object every plugin is handed.
  assert.match(note, /Any other plugin you install can still read it/)
})

// --- the storage picker ---------------------------------------------------

function openStorage(stored = {}, appOptions = {}) {
  const opened = open(stored, appOptions)
  return { ...opened, root: pageRoot(opened.tab, 'Storage') }
}

test('a fresh vault starts on the recommended provider and asks for one value', () => {
  const { root } = openStorage()
  const provider = rowNamed(root, 'Storage provider')
  assert.equal(inputIn(provider).value, 'r2')
  assert.ok(rowNamed(root, 'Account ID'), 'R2 asks for an account ID, not an endpoint')
  assert.equal(visible(rowNamed(root, 'Endpoint')), false, 'the raw endpoint lives in Advanced')
})

test('an existing R2 endpoint is recognised, and the account ID is read back out of it', () => {
  const { root } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  assert.equal(inputIn(rowNamed(root, 'Storage provider')).value, 'r2')
  assert.equal(inputIn(rowNamed(root, 'Account ID')).value, '0123456789abcdef0123456789abcdef')
  assert.match(root.textContent, /Your endpoint: https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com/)
})

test('an endpoint that matches no template is left alone as Other', () => {
  const { root } = openStorage({ destination: { endpoint: 'https://files.example.com', bucket: 'b' } })
  assert.equal(inputIn(rowNamed(root, 'Storage provider')).value, 'other')
  assert.equal(inputIn(rowNamed(root, 'Endpoint')).value, 'https://files.example.com')
})

test('Advanced starts closed when every field inside holds the provider default', () => {
  const { root } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'false')
  assert.equal(toggle.textContent, 'Advanced')
  assert.equal(visible(rowNamed(root, 'Key prefix')), false)
})

test('Advanced starts open when a key prefix is set, and says so on the label', () => {
  const { root } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.equal(toggle.textContent, 'Advanced · key prefix "notes"')
  assert.equal(visible(rowNamed(root, 'Key prefix')), true, 'nothing the user chose is ever hidden')
})

test('two non-default advanced fields are counted rather than listed', () => {
  const { root } = openStorage({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes', forcePathStyle: false },
  })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.textContent, 'Advanced · 2 fields changed')
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
})

test('Advanced opens and closes on click', () => {
  const { root } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const toggle = find(root, byClass('op-advanced-toggle'))
  click(toggle)
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.equal(visible(rowNamed(root, 'Key prefix')), true)
  click(toggle)
  assert.equal(toggle.getAttr('aria-expanded'), 'false')
})

test('switching provider keeps the bucket and the credentials', () => {
  const { root, plugin } = openStorage({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretRef: 'op-r2-secret' },
  })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'aws'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.bucket, 'my-notes')
  assert.equal(plugin.settings.destination.accessKeyId, 'AKIA')
  assert.equal(plugin.settings.destination.secretRef, 'op-r2-secret')
  assert.equal(plugin.settings.destination.provider, 'aws')
  assert.equal(plugin.settings.destination.endpoint, '', 'an account ID is not a region, so it is not carried over')
})

test('choosing the gateway swaps the form: one address and one token, no bucket and no keys', () => {
  const { root, plugin } = openStorage({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'AKIA', secretRef: 'op-r2-secret' },
  })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'gateway'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.type, 'gateway')
  assert.equal(plugin.settings.destination.accessKeyId, undefined, 'a key nothing uses is pure added risk')
  assert.equal(plugin.settings.destination.secretRef, undefined)

  const after = plugin.settings.destination
  const { root: gateway } = openStorage({ destination: after })
  assert.ok(rowNamed(gateway, 'Worker address'))
  assert.ok(rowNamed(gateway, 'Token'))
  assert.equal(rowNamed(gateway, 'Bucket'), null)
  assert.equal(rowNamed(gateway, 'Access key ID'), null)
  assert.equal(rowNamed(gateway, 'Region'), null, 'nothing here is signed, so there is no region to sign it for')
})

test('the token row holds a keychain name, and never the token', () => {
  // What this replaced asserted that the field was `type="password"`, which hid
  // the token from a person looking over your shoulder and from nothing else:
  // the value was still in `data.json` and still written into the DOM on every
  // render. There is no text input here at all now.
  const { root } = openStorage(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const row = rowNamed(root, 'Token')
  assert.equal(inputIn(row), null, 'nothing on this row takes typing')
  assert.equal(secretIn(row).settingKey, 'op-gateway-token', 'the component is pointed at the stored name')
  assert.match(descOf(row), /op-gateway-token/, 'and the name is legible without opening the picker')
  assert.doesNotMatch(root.textContent, /shh/, 'the token itself is never drawn')
})

test('linking a secret stores its name, and unlinking clears the name alone', () => {
  const { root, plugin } = openStorage(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const secret = secretIn(rowNamed(root, 'Token'))

  secret.link('op-gateway-token')
  assert.equal(plugin.settings.destination.tokenRef, 'op-gateway-token')

  // The real component passes null here, though its published type says string.
  secret.unlink()
  assert.equal(plugin.settings.destination.tokenRef, '', 'null is not a name')
})

test('a name this device cannot resolve is said out loud, and never quietly cleared', () => {
  // The ordinary state of every device after the first: `data.json` syncs and
  // the keychain does not. Obsidian's own component draws this exactly as it
  // draws a name that was never set, so if the row said nothing the obvious
  // move would be to link a *new* name, overwrite the one in `data.json`, sync
  // it back, and take down the device that was working.
  const { root, plugin } = openStorage({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  })
  const row = rowNamed(root, 'Token')
  assert.match(errorOf(row) ?? '', /this device does not have it/)
  assert.match(errorOf(row), /op-gateway-token/, 'named, so it can be recognised or recreated')
  assert.equal(plugin.settings.destination.tokenRef, 'op-gateway-token', 'and the name survives being unresolvable')
})

test('switching away from the gateway drops the token reference, and leaves the keychain alone', () => {
  const { root, plugin, tab } = openStorage(
    { destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' } },
    { secrets: { 'op-gateway-token': 'shh' } },
  )
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'r2'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.type, 's3')
  assert.equal(plugin.settings.destination.tokenRef, undefined)
  // Deliberate, and the half that changed. What is discarded is the reference;
  // the keychain is shared with every other plugin and is not this one's to
  // empty, and switching provider is something people switch back from.
  assert.equal(tab.app.secretStorage.getSecret('op-gateway-token'), 'shh')
  assert.equal(plugin.settings.destination.workerUrl, undefined)
  assert.equal(plugin.settings.destination.bucket, '', 'and it starts from a fresh S3 form, not a half-filled one')
})

test('a gateway keeps the one Advanced row it has a use for', () => {
  const { root } = openStorage({
    destination: { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token', prefix: 'notes' },
  })
  assert.match(find(root, byClass('op-advanced-toggle')).textContent, /key prefix "notes"/)
  assert.ok(rowNamed(root, 'Key prefix'))
  assert.equal(rowNamed(root, 'Path-style addressing'), null)
})

test('a key prefix that would silently address somewhere else is refused where it is typed', () => {
  // `a/../b` is not an invalid path, it is a valid path to somewhere else: the
  // URL parser removes the dot segment before any request is built, so this
  // cannot be caught downstream. The gateway Worker rejects ".." only on the
  // listing route, where the prefix survives in a query string.
  for (const destination of [
    { endpoint: R2_ENDPOINT, bucket: 'b' },
    { type: 'gateway', workerUrl: 'https://gw.workers.dev', tokenRef: 'op-gateway-token' },
  ]) {
    const { root } = openStorage({ destination })
    const row = rowNamed(root, 'Key prefix')
    const field = inputIn(row)

    field.value = 'notes/../elsewhere'
    dispatch(field, 'blur')
    assert.match(errorOf(row) ?? '', /cannot contain/, `${destination.type ?? 's3'}: accepted a traversing prefix`)

    field.value = 'notes/blog'
    dispatch(field, 'blur')
    assert.equal(errorOf(row), null, 'an ordinary prefix is still ordinary')
  }
})

test('switching to Other keeps the endpoint, because nothing about it is a template', () => {
  const { root, plugin } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes' } })
  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'other'
  dispatch(dropdown, 'input')
  assert.equal(plugin.settings.destination.endpoint, R2_ENDPOINT)
})

test('the composed endpoint updates as the account ID is typed', () => {
  const { root, plugin } = openStorage()
  const field = inputIn(rowNamed(root, 'Account ID'))
  field.value = 'abcdef01234567890abcdef012345678'
  dispatch(field, 'input')

  assert.equal(plugin.settings.destination.endpoint, 'https://abcdef01234567890abcdef012345678.r2.cloudflarestorage.com')
  assert.match(root.textContent, /Your endpoint: https:\/\/abcdef01234567890abcdef012345678\.r2\.cloudflarestorage\.com/)
})

test('the blank and the endpoint behind Advanced stay in step, in both directions', () => {
  // Otherwise: type an account ID with Advanced open, touch the endpoint field,
  // and the stale value it was still showing gets written back over the new one.
  const { root, plugin } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', prefix: 'notes' } })
  const account = inputIn(rowNamed(root, 'Account ID'))
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  assert.equal(endpoint.value, R2_ENDPOINT)

  account.value = 'ffffffffffffffffffffffffffffffff'
  dispatch(account, 'input')
  assert.equal(endpoint.value, 'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com')

  endpoint.value = 'https://notes.example.com'
  dispatch(endpoint, 'input')
  assert.equal(plugin.settings.destination.endpoint, 'https://notes.example.com')
  assert.equal(account.value, '', 'the endpoint no longer derives from an account ID, and says so')
  assert.match(root.textContent, /Your endpoint: https:\/\/notes\.example\.com/)
  assert.match(find(root, byClass('op-advanced-toggle')).textContent, /2 fields changed/)
})

test('a malformed account ID is reported on blur, never mid-typing', () => {
  const { root } = openStorage()
  const row = rowNamed(root, 'Account ID')
  const field = inputIn(row)

  field.value = 'abc'
  dispatch(field, 'input')
  assert.equal(errorOf(row), null, 'the first three characters of a 32-character ID are not an error')

  dispatch(field, 'blur')
  assert.match(errorOf(row), /32 letters and numbers/)

  field.value = '0123456789abcdef0123456789abcdef'
  dispatch(field, 'input')
  dispatch(field, 'blur')
  assert.equal(errorOf(row), null)
})

test('an address without a scheme is reported, on the providers that take one', () => {
  const { root } = openStorage({ destination: { provider: 'minio', endpoint: '' } })
  const row = rowNamed(root, 'Server address')
  const field = inputIn(row)
  field.value = 'localhost:9000'
  dispatch(field, 'input')
  dispatch(field, 'blur')
  assert.match(errorOf(row), /https:\/\/ or http:\/\//)
})

test('Wasabi carries its deletion cost wherever it is chosen', () => {
  const { root } = openStorage({ destination: { provider: 'wasabi', endpoint: 'https://s3.eu-central-1.wasabisys.com' } })
  assert.match(root.textContent, /90 days/)
})

test('the two-device row states the expectation, then the measured truth', async () => {
  const app = fakeApp({ files: [], folders: [] })
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
    testResult: { ok: true, conditionalWrites: 'ignored' },
  })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.update()
  const root = pageRoot(tab, 'Storage')

  assert.match(descOf(rowNamed(root, 'Publishing from two devices')), /Safe\./)

  click(buttonIn(rowNamed(root, 'Test connection')))
  await new Promise((resolve) => setImmediate(resolve))

  assert.match(descOf(rowNamed(root, 'Publishing from two devices')), /could overwrite each other/)
})

test('a storage target that no longer matches the published one says so', () => {
  const { root, tab } = openStorage({
    destination: { endpoint: R2_ENDPOINT, bucket: 'new-bucket', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
    lastPublishedTarget: `${R2_ENDPOINT}|old-bucket||path`,
  })
  const warning = find(root, byClass('op-storage-moved'))
  assert.ok(warning, 'switching storage after publishing is a migration, and has to be said out loud')
  assert.match(warning.textContent, /uploads everything again/)
  assert.match(warning.textContent, /keeps building from the old storage/)
  assert.equal(entry(tab, 'Storage').status(), 'warning', 'and the entry is marked before anybody opens it')
})

test('no such warning when the target is the one that was published to', () => {
  const { root, tab } = openStorage({
    destination: { endpoint: R2_ENDPOINT, bucket: 'my-notes', accessKeyId: 'k', secretRef: 'op-r2-secret' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(find(root, byClass('op-storage-moved')), null)
  assert.equal(entry(tab, 'Storage').status(), null)
})

test('the deletion charge is repeated where the money is actually spent', () => {
  const { tab } = open({ destination: { provider: 'wasabi', endpoint: 'https://s3.eu-central-1.wasabisys.com' } })
  assert.match(defNamed(tab, 'Clean up unused files').desc, /90 days/)

  const { tab: onR2 } = open({ destination: { endpoint: R2_ENDPOINT } })
  assert.doesNotMatch(defNamed(onR2, 'Clean up unused files').desc, /90 days/)
})

// --- what a review caught -------------------------------------------------

test('editing the endpoint moves the signing region with it, on the providers where they are the same thing', () => {
  // Otherwise every request is signed for the old region, S3 answers
  // SignatureDoesNotMatch, and the user is told their credentials were
  // rejected and goes off to regenerate keys that were never the problem.
  const { root, plugin } = openStorage({
    destination: {
      provider: 'aws',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      bucket: 'b',
      forcePathStyle: false,
    },
  })
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  endpoint.value = 'https://s3.us-east-1.amazonaws.com'
  dispatch(endpoint, 'input')

  assert.equal(plugin.settings.destination.region, 'us-east-1')
  assert.equal(inputIn(rowNamed(root, 'Region')).value, 'us-east-1', 'and the field says so')
})

test('an endpoint with no region in it leaves one editable by hand', () => {
  const { root, plugin } = openStorage({
    destination: {
      provider: 'aws',
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      bucket: 'b',
      forcePathStyle: false,
    },
  })
  const endpoint = inputIn(rowNamed(root, 'Endpoint'))
  endpoint.value = 'https://s3.internal.example.com'
  dispatch(endpoint, 'input')

  assert.equal(plugin.settings.destination.region, 'eu-west-1', 'the last known region stands')
  const region = inputIn(rowNamed(root, 'Region'))
  assert.ok(region, 'and there is somewhere to correct it')
  region.value = 'us-east-2'
  dispatch(region, 'input')
  assert.equal(plugin.settings.destination.region, 'us-east-2')
})

test('a region that disagrees with the endpoint is surfaced rather than left silent', () => {
  const { root } = openStorage({
    destination: { provider: 'aws', endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'us-east-1', forcePathStyle: false },
  })
  const toggle = find(root, byClass('op-advanced-toggle'))
  assert.equal(toggle.getAttr('aria-expanded'), 'true')
  assert.match(toggle.textContent, /region "us-east-1"/)
})

test('editing storage retires the last measurement rather than letting it go stale', async () => {
  const app = fakeApp({ files: [], folders: [] })
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
    testResult: { ok: true, conditionalWrites: 'enforced' },
  })
  const tab = new OpenPublishSettingTab(app, plugin)
  tab.update()
  const root = pageRoot(tab, 'Storage')

  click(buttonIn(rowNamed(root, 'Test connection')))
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(descOf(rowNamed(root, 'Publishing from two devices')), /Safe\./)

  const bucket = inputIn(rowNamed(root, 'Bucket'))
  bucket.value = 'somewhere-else'
  dispatch(bucket, 'input')
  assert.match(
    descOf(rowNamed(root, 'Publishing from two devices')),
    /Safe\./,
    'R2 still expects safety, but it is now an expectation again',
  )
})

test('switching provider mid-test drops the answer instead of pinning it to the new one', async () => {
  const app = fakeApp({ files: [], folders: [] })
  let release
  const plugin = fakeStoragePlugin({
    stored: { destination: { endpoint: R2_ENDPOINT, bucket: 'b', accessKeyId: 'k', secretRef: 'op-r2-secret' } },
  })
  plugin.testDestination = () => new Promise((resolve) => { release = () => resolve({ ok: true, conditionalWrites: 'enforced' }) })

  const tab = new OpenPublishSettingTab(app, plugin)
  tab.update()
  const root = pageRoot(tab, 'Storage')
  click(buttonIn(rowNamed(root, 'Test connection')))
  await new Promise((resolve) => setImmediate(resolve))

  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'b2'
  dispatch(dropdown, 'input')
  release()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.settings.destination.provider, 'b2')
  assert.match(
    descOf(rowNamed(root, 'Publishing from two devices')),
    /check two-device safety when you connect/,
    "R2's result says nothing about B2",
  )
})

test('changing provider updates the copy outside the storage form too', () => {
  // The form no longer has to repaint the whole tab to keep this true: the
  // cleanup caution is on another page now, and the tree is rebuilt on every
  // render, so it is right by the time anybody can read it.
  const { root, tab, plugin } = openStorage({ destination: { endpoint: R2_ENDPOINT, bucket: 'b' } })
  assert.doesNotMatch(defNamed(tab, 'Clean up unused files').desc, /90 days/)

  const dropdown = inputIn(rowNamed(root, 'Storage provider'))
  dropdown.value = 'wasabi'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.destination.provider, 'wasabi')
  tab.update()
  assert.match(defNamed(tab, 'Clean up unused files').desc, /90 days/)
  assert.equal(entry(tab, 'Storage').displayValue(), 'Wasabi', 'and the entry says where it now points')
})

// --- the site build section ----------------------------------------------

const NETLIFY_HOOK = 'https://api.netlify.com/build_hooks/68a1f0c2d3e4b5a6c7d8e9f0'
const PAGES_HOOK = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/0f7a1c2e3b4d5e6f'

function openBuild(stored = {}, appOptions = {}) {
  const opened = open(stored, appOptions)
  return { ...opened, root: pageRoot(opened.tab, 'Site build') }
}

const buildSection = (root) => find(root, byClass('op-build-fields'))

test('a fresh vault starts on the recommended host and asks for a hook URL', () => {
  const { root } = openBuild()
  const host = rowNamed(root, 'Hosting provider')
  assert.equal(inputIn(host).value, 'cloudflare-pages')
  assert.ok(rowNamed(root, 'Deploy hook URL'))
  assert.ok(rowNamed(root, 'Site URL'))
  assert.equal(visible(rowNamed(root, 'Build logs URL')), false, 'the optional one lives in Advanced')
})

test('the free plan quoted is the one the user is actually on', () => {
  // The bug this replaced: every user, on every host, was told "Cloudflare
  // Pages' free plan allows 500 builds a month", which on Netlify is wrong by
  // more than an order of magnitude in the direction that costs them the month.
  const { root } = openBuild({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.match(descOf(rowNamed(root, 'Minimum minutes between builds')), /500 builds a month/)

  const { root: onNetlify } = openBuild({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  const desc = descOf(rowNamed(onNetlify, 'Minimum minutes between builds'))
  assert.match(desc, /about 20 site updates a month/)
  assert.doesNotMatch(desc, /Cloudflare|500 builds/)
})

test('only the host whose month can run out gets a standing panel', () => {
  const { root } = openBuild({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  const panel = find(root, byClass('op-build-allowance'))
  assert.ok(panel, 'a 20-deploy month is worth a panel next to the switch that spends it')
  assert.match(panel.textContent, /Build after publishing/)

  const { root: onPages } = openBuild({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  assert.equal(find(onPages, byClass('op-build-allowance')), null, 'undifferentiated warnings train dismissal')
})

test('the two controls that govern the bill stay out of Advanced', () => {
  const { root } = openBuild({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  assert.equal(visible(rowNamed(root, 'Build after publishing')), true)
  assert.equal(visible(rowNamed(root, 'Minimum minutes between builds')), true)
})

test('an existing hook URL is recognised, and the label says where it came from', () => {
  const { root } = openBuild({ builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'netlify')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /Recognised from your deploy hook/)
})

test('a hook URL that matches nothing claims nothing', () => {
  const { root } = openBuild({ builder: { url: 'https://relay.example.com/build/x', siteUrl: 'https://notes.example.com' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'other')
  assert.doesNotMatch(descOf(rowNamed(root, 'Hosting provider')), /Recognised from/)
})

test('pasting a hook URL relabels the host without disturbing what was typed', () => {
  const { root, plugin } = openBuild({ builder: { siteUrl: 'https://x.netlify.app', minIntervalMinutes: 17 } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = NETLIFY_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'netlify')
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'netlify', 'and the control says so')
  assert.equal(plugin.settings.builder.siteUrl, 'https://x.netlify.app')
  assert.equal(plugin.settings.builder.minIntervalMinutes, 17, 'a number that governs a bill is never inferred')
})

test("relabelling brings the new host's caveat with it, rather than dropping it", () => {
  // setDesc replaces the description element's contents, so anything under it
  // has to be rebuilt. Getting this wrong silently lost the one line saying
  // that renames will not redirect on Vercel.
  const { root } = openBuild()
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = 'https://api.vercel.com/v1/integrations/deploy/prj_a/b1'
  dispatch(hook, 'input')

  const desc = descOf(rowNamed(root, 'Hosting provider'))
  assert.match(desc, /100 deploys a day/)
  assert.match(desc, /vercel\.json/)
  assert.match(desc, /Recognised from your deploy hook/)
})

test('switching host by hand keeps the hook URL and the site URL', () => {
  const { root, plugin } = openBuild({ builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' } })
  const dropdown = inputIn(rowNamed(root, 'Hosting provider'))
  dropdown.value = 'vercel'
  dispatch(dropdown, 'input')

  assert.equal(plugin.settings.builder.host, 'vercel')
  assert.equal(plugin.settings.builder.url, PAGES_HOOK, 'a deploy hook URL can only be pasted, never derived')
  assert.equal(plugin.settings.builder.siteUrl, 'https://x.pages.dev')
})

test('an explicit pick that disagrees with the hook URL is stated once, not argued with', () => {
  const { root } = openBuild({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'vercel', 'the deliberate choice stands')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /looks like a Netlify one/)
})

test('a host that cannot report its own address says so where the address is typed', () => {
  const { root } = openBuild({ builder: { host: 'cloudflare-workers', url: '', siteUrl: '' } })
  assert.match(descOf(rowNamed(root, 'Site URL')), /OP_SITE_URL/)

  const { root: onPages } = openBuild({ builder: { url: PAGES_HOOK } })
  assert.doesNotMatch(descOf(rowNamed(onPages, 'Site URL')), /OP_SITE_URL/)
})

test('a deliberate pick survives the hook URL being edited again', () => {
  // Inference applies itself on new evidence, not on every keystroke. Re-typing
  // a URL that says what it already said is not new evidence, and overruling a
  // deliberate choice with it made the "looks like a Netlify one" line
  // unreachable through the very form that shows it.
  const { root, plugin } = openBuild({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))

  hook.value = ''
  dispatch(hook, 'input')
  hook.value = NETLIFY_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'vercel', 'the deliberate choice stands')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /looks like a Netlify one/)
})

test('a genuinely different hook URL does overrule the earlier pick', () => {
  const { root, plugin } = openBuild({ builder: { url: NETLIFY_HOOK, host: 'vercel', siteUrl: 'https://x.netlify.app' } })
  const hook = inputIn(rowNamed(root, 'Deploy hook URL'))
  hook.value = PAGES_HOOK
  dispatch(hook, 'input')

  assert.equal(plugin.settings.builder.host, 'cloudflare-pages', 'a new host is new evidence')
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /Recognised from your deploy hook/)
})

test('the escape-hatch host asks for a site address the build can read', () => {
  const { root } = openBuild({ builder: { url: 'https://relay.example.com/build/x', siteUrl: 'https://notes.example.com' } })
  assert.equal(inputIn(rowNamed(root, 'Hosting provider')).value, 'other')
  assert.match(descOf(rowNamed(root, 'Site URL')), /OP_SITE_URL/)
})

test("Vercel's missing redirects are a line, not an alarm", () => {
  const { root } = openBuild({ builder: { host: 'vercel', url: 'https://api.vercel.com/v1/integrations/deploy/prj_a/b1' } })
  assert.match(descOf(rowNamed(root, 'Hosting provider')), /vercel\.json/)
  assert.equal(find(buildSection(root), byClass('op-build-allowance')), null)
})

test('Advanced holds the build logs URL, and opens by itself when one is set', () => {
  const { root } = openBuild({ builder: { url: PAGES_HOOK } })
  const closed = find(buildSection(root), byClass('op-advanced-toggle'))
  assert.equal(closed.getAttr('aria-expanded'), 'false')
  assert.equal(closed.textContent, 'Advanced')

  const { root: withLogs } = openBuild({ builder: { url: PAGES_HOOK, logsUrl: 'https://dash.example/logs' } })
  const open2 = find(buildSection(withLogs), byClass('op-advanced-toggle'))
  assert.equal(open2.getAttr('aria-expanded'), 'true')
  assert.equal(open2.textContent, 'Advanced · build logs URL')
  assert.equal(visible(rowNamed(withLogs, 'Build logs URL')), true)
})

test('the request method is reachable, and says so when it is not the default', () => {
  // It was stored, read by the builder, and settable from nowhere, so only POST
  // could ever be sent. A hook behind a relay is the case that needs it.
  const { root, plugin } = openBuild({ builder: { url: PAGES_HOOK } })
  const toggle = find(buildSection(root), byClass('op-advanced-toggle'))
  click(toggle)
  const method = inputIn(rowNamed(root, 'Request method'))
  assert.equal(method.value, 'POST')

  method.value = 'GET'
  dispatch(method, 'input')
  assert.equal(plugin.settings.builder.method, 'GET')
  assert.equal(toggle.textContent, 'Advanced · GET request')

  const { root: reopened } = openBuild({ builder: { url: PAGES_HOOK, method: 'GET' } })
  assert.equal(
    find(buildSection(reopened), byClass('op-advanced-toggle')).getAttr('aria-expanded'),
    'true',
    'nothing the user chose is hidden behind a closed section',
  )
})

test('the check button refuses an unfinished form before making a request', async () => {
  const { root, plugin } = openBuild({ builder: { url: PAGES_HOOK, siteUrl: '' } })
  click(buttonIn(rowNamed(root, 'Check the site')))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(plugin.calls.builderChecks, 0)
})

test('a host the site was never published from says so, and keeps saying it', () => {
  const { root, tab } = openBuild({
    builder: { url: NETLIFY_HOOK, siteUrl: 'https://x.netlify.app' },
    lastSnapshotId: 'snap-1',
    lastPublishedHostTarget: 'cloudflare-pages|https://x.pages.dev',
  })
  const warning = find(root, byClass('op-host-moved'))
  assert.ok(warning, 'the old host keeps serving, so nothing breaks and nobody finds out')
  assert.match(warning.textContent, /still being served by the host you last published to/)
  assert.match(warning.textContent, /needs the same variables as the old one/)
  assert.equal(entry(tab, 'Site build').status(), 'warning', 'and the entry is marked before anybody opens it')
})

test('no such warning when this is the host that was published from', () => {
  const { root, tab } = openBuild({
    builder: { url: PAGES_HOOK, siteUrl: 'https://x.pages.dev' },
    lastSnapshotId: 'snap-1',
  })
  assert.equal(find(root, byClass('op-host-moved')), null)
  assert.equal(entry(tab, 'Site build').status(), null)
})

// --- site history ---------------------------------------------------------

test('Maintenance offers Site history, next to the other storage-wide jobs', () => {
  const { tab } = open()
  assert.deepEqual(itemNames(entry(tab, 'Maintenance')), [
    ROLLBACK_HEADLINE,
    'Last publish',
    'Site history',
    'Storage self-test',
    'Clean up unused files',
    'Re-check every file',
  ])
  const def = defNamed(tab, 'Site history')
  assert.match(def.desc, /earlier version of your site live again/)
  assert.equal(buttonIn(drawn(def)).textContent, 'Browse')
})

test('a site left on an older version says so, and keeps saying it', () => {
  const { tab } = open({
    lastSnapshotId: '2026-08-14T09-12-00Z-aaaaaa',
    lastRollback: { to: '2026-08-14T09-12-00Z-aaaaaa', from: '2026-08-20T11-30-00Z-bbbbbb', at: 1 },
  })
  const panel = defNamed(tab, ROLLBACK_HEADLINE)
  assert.ok(panel, 'a Notice fired at rollback time is gone by the moment this matters')
  assert.equal(panel.visible(), true)
  assert.match(panel.name, /showing an older version/)
  assert.match(panel.desc, /Publishing takes the site forward/)
  assert.ok(drawn(panel).hasClass('op-notice-warning'), 'and it is drawn as a warning, not as another row')
  assert.equal(entry(tab, 'Maintenance').status(), 'warning')
})

test('the panel lives in Maintenance, not in Storage: this is publish history, not a bucket move', () => {
  const { tab } = open({ lastRollback: { to: '2026-08-14T09-12-00Z-aaaaaa', from: null, at: 1 } })
  assert.equal(
    itemNames(entry(tab, 'Maintenance'))[0],
    ROLLBACK_HEADLINE,
    'above the rows it is about, so the explanation arrives before the control',
  )
  assert.equal(entry(tab, 'Storage').status(), null, 'and it raises no storage warning')
  assert.equal(find(pageRoot(tab, 'Storage'), byClass('op-storage-moved')), null)
})

test('no panel once a publish has taken the site forward again', () => {
  const { tab } = open({ lastSnapshotId: 'snap-2' })
  assert.equal(defNamed(tab, ROLLBACK_HEADLINE).visible(), false)
  assert.equal(entry(tab, 'Maintenance').status(), null)
})

test('the Last publish row stops naming a version once a rollback has moved it', () => {
  // `lastSnapshotId` follows the rollback and `lastPublishedAt` does not, which
  // is right for both fields and a lie when read as one sentence: it would date
  // a publish that never happened. The panel above says what is live.
  const stored = { lastSnapshotId: '2026-08-14T09-12-00Z-aaaaaa', lastPublishedAt: 1_700_000_000_000 }
  const { tab } = open(stored)
  assert.match(defNamed(tab, 'Last publish').desc, /\(version 2026-08-14T09-12-00Z-aaaaaa\)/)

  const { tab: rolled } = open({
    ...stored,
    lastRollback: { to: '2026-08-14T09-12-00Z-aaaaaa', from: '2026-08-20T11-30-00Z-bbbbbb', at: 1 },
  })
  const desc = defNamed(rolled, 'Last publish').desc
  assert.equal(desc, new Date(1_700_000_000_000).toLocaleString())
  assert.doesNotMatch(desc, /version/)
})

test('the maintenance jobs each run the one they are named for', async () => {
  const { tab, plugin } = open()
  click(buttonIn(drawn(defNamed(tab, 'Storage self-test'))))
  click(buttonIn(drawn(defNamed(tab, 'Clean up unused files'))))
  click(buttonIn(drawn(defNamed(tab, 'Re-check every file'))))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(plugin.calls.selfTests, 1)
  assert.equal(plugin.calls.cleanups, 1)
  assert.equal(plugin.calls.cacheClears, 1)
})

// --- what gets published --------------------------------------------------

const perFileList = (tab) => (entry(tab, 'What gets published').items ?? []).find((item) => item.type === 'list')

test('the per-file heading is there before anyone has made a per-file choice', () => {
  // It used to return early on an empty map, which made it invisible to
  // everybody who had never right-clicked a note: the one route into
  // publishing with no control anywhere on screen.
  const { tab } = open()
  const list = perFileList(tab)

  assert.equal(list.heading, 'Per-file choices', 'the heading is declared with nothing under it')
  assert.match(list.emptyState, /Right click any note and choose "Publish with Open Publish"/)
  assert.deepEqual(list.items, [], 'and nothing else: no list')
  assert.equal(defNamed(tab, 'Forget every per-file choice').visible(), false, 'nothing to clear')
})

test('and it becomes a list once there is something to list', () => {
  const { tab } = open({ selection: { includes: [], excludes: [], explicit: { 'Notes/Home.md': true } } })
  const list = perFileList(tab)

  assert.deepEqual(itemNames(list), ['Notes/Home.md'])
  assert.match(list.items[0].desc, /Published on its own/)
  assert.equal(defNamed(tab, 'Forget every per-file choice').visible(), true)
})

test('a choice the note overrules in its own frontmatter says so on the row', () => {
  const { tab } = open(
    { selection: { includes: [], excludes: [], explicit: { 'Notes/Home.md': true } } },
    { frontmatter: { 'Notes/Home.md': { publish: false } } },
  )
  assert.match(perFileList(tab).items[0].desc, /sets publish: false in its frontmatter, which wins/)
})

test('deleting a row forgets that one choice, and clearing forgets them all', () => {
  const explicit = { 'Notes/Home.md': true, 'Notes/Other.md': false }
  const { tab, plugin } = open({ selection: { includes: [], excludes: [], explicit } })

  perFileList(tab).onDelete(0)
  assert.deepEqual(Object.keys(plugin.settings.selection.explicit), ['Notes/Other.md'])
  assert.deepEqual(itemNames(perFileList(tab)), ['Notes/Other.md'], 'and the list is rebuilt around what is left')

  click(buttonIn(drawn(defNamed(tab, 'Forget every per-file choice'))))
  assert.deepEqual(plugin.settings.selection.explicit, {})
})

test('the folder summary is the same count in two widths', () => {
  const { tab } = open(
    { selection: { includes: ['Notes'], excludes: [], explicit: {} } },
    { files: ['Notes/Home.md', 'Notes/Two.md'], folders: ['Notes'] },
  )
  assert.match(entry(tab, 'What gets published').displayValue(), /including 1 folder/)
  assert.match(defNamed(tab, 'Folders').desc, /1 included · 2 notes published/)
  assert.equal(buttonIn(drawn(defNamed(tab, 'Folders'))).textContent, 'Manage folders…')
})

test('embedded attachments are one toggle, and it writes where the scan reads', async () => {
  const { tab, plugin } = open()
  const def = defNamed(tab, 'Include embedded attachments automatically')
  assert.equal(def.control.key, 'selection.autoIncludeEmbeds')
  assert.match(def.desc, /usual cause of a site with broken images/)

  await tab.setControlValue('selection.autoIncludeEmbeds', false)
  assert.equal(plugin.settings.selection.autoIncludeEmbeds, false)
})
