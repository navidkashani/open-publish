/**
 * The settings tree, with no Obsidian anywhere.
 *
 * This file deliberately does **not** import `harness.mjs`, so no resolve hook
 * is installed and nothing rewrites `obsidian` to a stub. `node --test` runs
 * each file in its own process, which is what makes that a real constraint:
 * the moment `settingDefinitions.ts` (or anything it imports) reaches for an
 * Obsidian *value*, every test below fails with "Cannot find package
 * 'obsidian'". That is the doctrine in `README.md` enforcing itself, with no
 * assertion written for it.
 *
 * What it covers is what only it can: the control-key table, which is the one
 * new class of bug the declarative API introduces. A key is a string, so a
 * typo is invisible to the compiler and would surface as a setting that
 * silently reads and writes nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, migrateSettings } from '../src/settings.ts'
import {
  RERENDER_KEYS,
  readSetting,
  settingDefinitions,
  storageSummary,
  writeSetting,
} from '../src/ui/settingDefinitions.ts'

/**
 * Everything the tree needs, faked.
 *
 * Nothing here is exercised by the assertions below: the point of this file is
 * that building the array never calls a single one of them, which is exactly
 * why the tree can be read as data.
 */
function deps(stored = {}) {
  const unreachable = () => {
    throw new Error('building the definitions must never call out')
  }
  return {
    settings: migrateSettings(stored),
    save: async () => {},
    update: () => {},
    storagePage: unreachable,
    buildPage: unreachable,
    openSetup: unreachable,
    openFolders: unreachable,
    openNavigation: unreachable,
    openRollback: unreachable,
    filePaths: () => [],
    markdownPaths: () => [],
    folderExists: () => false,
    fileExists: () => false,
    isNotePublished: () => true,
    frontmatterPublish: () => null,
    attachPathSuggest: unreachable,
    normalizeTypedPath: (typed) => typed,
    navSizeWarning: () => null,
    runSelfTest: unreachable,
    runCleanup: unreachable,
    clearHashCache: unreachable,
    notify: unreachable,
  }
}

function* walk(nodes) {
  for (const node of nodes ?? []) {
    yield node
    yield* walk(node.items)
  }
}

const controlsIn = (items) => [...walk(items)].filter((def) => def.control).map((def) => ({ name: def.name, ...def.control }))

test('the tree builds without touching Obsidian, or anything injected', () => {
  const items = settingDefinitions(deps())
  assert.equal(items.length, 8)
  assert.deepEqual(
    items.map((item) => item.name),
    [
      'Setup',
      'Storage',
      'Site build',
      'What gets published',
      'Site options',
      'Appearance',
      'Maintenance',
      'About your credentials',
    ],
  )
})

test('every control key names a setting that actually exists, and round-trips', () => {
  // A key is a plain string, so nothing but this notices `site.showBackLinks`.
  for (const control of controlsIn(settingDefinitions(deps()))) {
    const settings = migrateSettings({})
    const current = readSetting(settings, control.key)
    assert.notEqual(current, undefined, `${control.name}: "${control.key}" is not a setting`)
    assert.equal(
      readSetting(DEFAULT_SETTINGS, control.key),
      readSetting(migrateSettings({}), control.key),
      `${control.name}: "${control.key}" does not read the shipped default`,
    )

    const next =
      control.type === 'toggle'
        ? !current
        : control.type === 'dropdown'
          ? Object.keys(control.options).find((option) => option !== current)
          : 'typed-value'
    writeSetting(settings, control.key, next)
    assert.equal(readSetting(settings, control.key), next, `${control.name}: "${control.key}" did not round-trip`)
  }
})

test('no two controls claim the same key', () => {
  const keys = controlsIn(settingDefinitions(deps())).map((control) => control.key)
  assert.deepEqual([...new Set(keys)].sort(), [...keys].sort())
})

test('the keys that force a rebuild are keys something is actually declared with', () => {
  const keys = new Set(controlsIn(settingDefinitions(deps())).map((control) => control.key))
  for (const key of RERENDER_KEYS) assert.ok(keys.has(key), `${key} is not a control key`)
})

test('a language is never written without the direction that goes with it', () => {
  const settings = migrateSettings({})
  writeSetting(settings, 'site.locale', 'fa-IR')
  assert.equal(settings.site.dir, 'rtl')
  writeSetting(settings, 'site.locale', 'de-DE')
  assert.equal(settings.site.dir, 'ltr')

  writeSetting(settings, 'site.locale', 'not-a-tag')
  assert.equal(settings.site.locale, 'de-DE', 'and a tag nobody offers is refused rather than stored')
})

test('the unions a dropdown hands back as a bare string are checked before storing', () => {
  const settings = migrateSettings({})

  writeSetting(settings, 'urlStyle', 'nonsense')
  assert.equal(settings.urlStyle, 'clean')

  writeSetting(settings, 'site.analytics.provider', 'matomo')
  assert.equal(settings.site.analytics.provider, 'none', 'a provider nothing can render is not stored')
  writeSetting(settings, 'site.analytics.provider', 'plausible')
  assert.equal(settings.site.analytics.provider, 'plausible')
})

test('a tracking ID is trimmed on the way in, wherever it was pasted from', () => {
  const settings = migrateSettings({})
  writeSetting(settings, 'site.analytics.id', '  notes.example.com \n')
  assert.equal(settings.site.analytics.id, 'notes.example.com')
})

test('a key that leads nowhere writes nothing rather than building a path', () => {
  const settings = migrateSettings({})
  writeSetting(settings, 'site.nothing.here', true)
  assert.equal(readSetting(settings, 'site.nothing'), undefined)
  assert.equal(readSetting(settings, 'destination.bucket.deeper'), undefined)
})

test('the storage entry names the provider, and the prefix when there is one', () => {
  assert.equal(storageSummary(migrateSettings({})), 'Cloudflare R2')
  assert.equal(storageSummary(migrateSettings({ destination: { provider: 'wasabi' } })), 'Wasabi')
  assert.equal(
    storageSummary(migrateSettings({ destination: { provider: 'wasabi', prefix: 'notes' } })),
    'Wasabi · notes',
  )
})
