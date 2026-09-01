/**
 * The starter catalogue is copy and one load-bearing fact.
 *
 * The copy is worth the same shallow checks the other two catalogues get. The
 * fact is `build.outputDir`, and it is the reason this table exists at all: a
 * host told the wrong directory deploys an empty one and reports success, which
 * is a failure nobody sees until they open their own site. So the invariant
 * proved hardest here is that no two starters can be confused for one another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { STARTERS, isStarterId, starterById } from '../src/builders/starters.ts'

test('every starter has the copy each surface needs', () => {
  for (const starter of STARTERS) {
    assert.ok(starter.name, `${starter.id}: no name`)
    assert.ok(starter.summary.endsWith('.'), `${starter.id}: summary is not a sentence`)
    assert.match(starter.repoUrl, /^https:\/\/github\.com\//, `${starter.id}: the template is not a GitHub URL`)
    assert.ok(starter.build.command.length > 0, `${starter.id}: no build command`)
    assert.ok(starter.build.outputDir.length > 0, `${starter.id}: no output directory`)
    assert.equal(typeof starter.build.hasWranglerConfig, 'boolean', `${starter.id}: unstated wrangler support`)
    if (starter.caution) {
      assert.ok(starter.caution.endsWith('.'), `${starter.id}: caution is not a sentence`)
    }
  }
})

test('exactly one recommendation, and it leads the list', () => {
  assert.equal(STARTERS.filter((starter) => starter.recommended).length, 1)
  assert.equal(STARTERS[0].recommended, true)
})

test('the output directories differ, which is the whole reason this is stored', () => {
  const dirs = STARTERS.map((starter) => starter.build.outputDir)
  assert.equal(new Set(dirs).size, dirs.length, 'two starters sharing a directory would make the choice cosmetic')
  assert.equal(starterById('quartz').build.outputDir, 'public')
  assert.equal(starterById('jotter').build.outputDir, 'dist')
})

test('an unknown id falls back to the starter the list recommends', () => {
  // Unlike `hostById`, which falls back to a deliberate "Another host" escape
  // hatch at the end of its list. There is no such entry here: an id we do not
  // know is a stale or corrupt setting.
  assert.equal(starterById('made up').id, 'jotter')
  assert.equal(starterById(undefined).id, 'jotter')
  assert.equal(starterById('').id, 'jotter')
})

test('the recommended starter is the one the fallback lands on', () => {
  // Two facts that have to agree and are set in different places: `recommended`
  // on an entry, and `FALLBACK` being the first of them. A picker whose badge
  // and whose default disagree is a picker nobody can reason about.
  assert.equal(starterById('made up').id, STARTERS.find((starter) => starter.recommended).id)
})

test('isStarterId accepts only what the table holds', () => {
  assert.equal(isStarterId('jotter'), true)
  assert.equal(isStarterId('quartz'), true)
  assert.equal(isStarterId('hugo'), false)
  assert.equal(isStarterId(undefined), false)
  assert.equal(isStarterId(null), false)
  assert.equal(isStarterId(7), false)
})

test('the two templates are different repositories', () => {
  const repos = STARTERS.map((starter) => starter.repoUrl)
  assert.equal(new Set(repos).size, repos.length)
})
