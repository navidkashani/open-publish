/**
 * The language table, and the one thing derived from it.
 *
 * `dir` has no control of its own: it is whatever `directionFor` says, in the
 * settings panel and again on every load. So the table is the only place a
 * wrong direction can come from, and these are the checks on it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LOCALE, LOCALES, directionFor, isLocale, localeLabel } from '../src/core/locales.ts'

test('direction is derived from the language, not guessed at', () => {
  assert.equal(directionFor('fa-IR'), 'rtl')
  assert.equal(directionFor('ar-SA'), 'rtl')
  assert.equal(directionFor('en-US'), 'ltr')
  assert.equal(directionFor('ja-JP'), 'ltr')
})

test('an unrecognised tag reads left to right rather than throwing', () => {
  // Unreachable through the settings panel, which validates on load and on
  // change. Reachable from a snapshot written by a newer plugin.
  assert.equal(directionFor('klingon'), 'ltr')
  assert.equal(directionFor(''), 'ltr')
})

test('every entry is a usable option: a tag, a label, and one of two directions', () => {
  for (const locale of LOCALES) {
    assert.match(locale.tag, /^[a-z]{2}-[A-Z]{2}$/, `${locale.tag} is not a region-qualified tag`)
    assert.ok(locale.label.length > 0, `${locale.tag} has no label`)
    assert.ok(['ltr', 'rtl'].includes(locale.dir), `${locale.tag} has direction ${locale.dir}`)
  }
})

test('exactly two languages read right to left, and they are the two we think', () => {
  // Named rather than counted, because the whole reason the list is closed is
  // that this stays checkable by hand.
  assert.deepEqual(
    LOCALES.filter((locale) => locale.dir === 'rtl').map((locale) => locale.tag),
    ['ar-SA', 'fa-IR'],
  )
})

test('no tag is listed twice, and the default is one of them', () => {
  const tags = LOCALES.map((locale) => locale.tag)
  assert.equal(new Set(tags).size, tags.length)
  assert.ok(isLocale(DEFAULT_LOCALE), 'the default has to be selectable')
  assert.deepEqual([...tags].sort(), tags, 'kept sorted by tag, so the RTL pair stays easy to find')
})

test('anything not in the table is not a locale', () => {
  for (const junk of ['fa', 'en_US', 'klingon', '', null, 42, { tag: 'en-US' }]) {
    assert.equal(isLocale(junk), false, `${JSON.stringify(junk)} was accepted`)
  }
})

test('a tag a newer plugin knows about is still readable in a rollback diff', () => {
  assert.equal(localeLabel('fa-IR'), 'Persian (Iran)')
  assert.equal(localeLabel('sv-SE'), 'sv-SE')
})
