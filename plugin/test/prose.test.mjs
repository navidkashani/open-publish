/**
 * One rule about the writing, enforced rather than remembered.
 *
 * A pass through this repository once removed 283 em dashes, and nothing stood
 * between it and the 284th. This is that thing. It reads the working tree
 * rather than a list of files, so a new file is covered the moment it exists.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname

/** Build output and dependencies are not ours to write. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'public', 'dist', '.obsidian'])
const SKIP_FILES = new Set(['main.js', 'package-lock.json'])
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|css|yml|yaml)$/

/** Built rather than typed, so this file is not its own first offender. */
const EM_DASH = String.fromCharCode(0x2014)

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (TEXT.test(entry)) out.push(path)
  }
  return out
}

test('no em dashes anywhere in the repository', () => {
  const offenders = []
  for (const path of walk(ROOT)) {
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((line, index) => {
      if (line.includes(EM_DASH)) offenders.push(`${relative(ROOT, path)}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `use a comma, a colon, or two sentences:\n${offenders.join('\n')}`)
})
