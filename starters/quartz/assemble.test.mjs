/**
 * The overlay's copy list, checked against the overlay itself.
 *
 * `assemble.mjs` copies a hardcoded list of files into the template and skips,
 * without complaint, anything not on it. That silence has already cost
 * something: `wrangler.jsonc` was added to the overlay, never added to the
 * list, and was simply absent from the published template. Nothing failed. The
 * Workers Builds setup it exists to enable just did not work, and the file
 * sitting right there in the source tree said otherwise.
 *
 * So every file in the overlay must be declared: shipped, or deliberately not.
 * Adding a file without deciding which is the failure this catches.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OVERLAY_FILES, NOT_SHIPPED } from './assemble.mjs'

const OVERLAY = dirname(fileURLToPath(import.meta.url))

/**
 * What git tracks here, one entry per top-level name.
 *
 * Deliberately not `readdirSync`: `npm run verify` caches a whole Quartz
 * checkout at `.quartz/`, so reading the directory makes this test fail for
 * anyone who runs verify before check. Ignored artefacts are not the overlay,
 * and the thing being guarded is the set of files we author.
 */
function trackedTopLevel() {
  const out = execFileSync('git', ['ls-files', '-z', '.'], { cwd: OVERLAY, encoding: 'utf8' })
  const names = out.split('\0').filter(Boolean).map((path) => path.split('/')[0])
  return [...new Set(names)].sort()
}

test('every file in the overlay is either shipped or explicitly held back', () => {
  const declared = new Set([...OVERLAY_FILES, ...NOT_SHIPPED])
  const undeclared = trackedTopLevel().filter((name) => !declared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    'add these to OVERLAY_FILES to ship them, or to NOT_SHIPPED to say why not',
  )
})

test('every file the copy list names actually exists', () => {
  // The copy loop skips a missing source silently, so a rename here is the same
  // failure as a missing entry: the template quietly loses the file.
  const missing = OVERLAY_FILES.filter((name) => !existsSync(join(OVERLAY, name)))
  assert.deepEqual(missing, [], 'OVERLAY_FILES names something that is not in the overlay')
})

test('the two lists do not overlap', () => {
  const shipped = new Set(OVERLAY_FILES)
  const both = NOT_SHIPPED.filter((name) => shipped.has(name))
  assert.deepEqual(both, [], 'a file cannot be both shipped and held back')
})

test('the Workers Builds config is one of the files that ships', () => {
  // Named rather than left to the sweep above, because this is the file that
  // was missing, and `wrangler.test.mjs` asserts its contents while assuming it
  // reaches the template at all.
  assert.ok(
    OVERLAY_FILES.includes('wrangler.jsonc'),
    'wrangler.jsonc is tested but was never copied; that is the bug, not the test',
  )
})
