/**
 * What an import would do, before anything is written.
 *
 * The asymmetry is the thing being protected here, and it has a test of its
 * own further down: includes are replaced, because Publish's include list is
 * the user's answer to "what is public"; excludes are only ever added to,
 * because replacing them with Publish's usually-empty list would delete a
 * guard somebody added by hand and quietly enlarge the published set. In a
 * feature whose failure mode is "242 private notes go public", the default
 * cannot be the one that publishes more.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  importButtonLabel,
  importSentence,
  importWarnings,
  importedNotice,
  planPublishImport,
} from '../src/ui/PublishImport.ts'
import { summarizeRules } from '../src/ui/FolderRules.ts'

const FILES = [
  'Notes/Luhmann.md',
  'Notes/Zettelkasten.md',
  'Notes/Drafts/Half thought.md',
  'Ideas/WIP.md',
  'Archive/2024/Old.md',
]
const FOLDERS = new Set(['Notes', 'Notes/Drafts', 'Ideas', 'Archive', 'Archive/2024'])

/** A parsed configuration, with the two fields the plan actually reads. */
const publishConfig = ({ included = [], excluded = [], hasFilters = true } = {}) => ({
  included,
  excluded,
  siteId: 'e06fc8eb0e577dd6b3e0c6295c8602ad',
  host: 'publish-01.obsidian.md',
  hasFilters,
})

const rules = ({ includes = [], excludes = [], explicit = {} } = {}) => ({ includes, excludes, explicit })

const summarize = (plan) =>
  summarizeRules({
    files: FILES,
    includes: plan.includes,
    excludes: plan.excludes,
    folderExists: (path) => FOLDERS.has(path),
  })

const warnings = (plan, { dropped = [], live = false } = {}) =>
  importWarnings({ plan, after: summarize(plan), dropped, live })

test('a fresh vault takes every folder, and loses nothing', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules())

  assert.deepEqual(plan.includes, ['Notes', 'Ideas'])
  assert.deepEqual(plan.excludes, [])
  assert.deepEqual(plan.changes, [
    { rule: 'Notes', list: 'includes', effect: 'added' },
    { rule: 'Ideas', list: 'includes', effect: 'added' },
  ])
  assert.equal(plan.empty, false)
  assert.equal(plan.unchanged, false)
})

test('an include this vault has and Publish does not is removed: the one destructive half', () => {
  const plan = planPublishImport(
    publishConfig({ included: ['Notes'] }),
    rules({ includes: ['Notes', 'Archive'] }),
  )

  assert.deepEqual(plan.includes, ['Notes'])
  assert.deepEqual(plan.changes, [
    { rule: 'Notes', list: 'includes', effect: 'kept' },
    { rule: 'Archive', list: 'includes', effect: 'removed' },
  ])
})

test('an exclude this vault has and Publish does not is KEPT, never removed', () => {
  // The safety asymmetry. An excluded folder can only ever publish less, so
  // dropping one here would enlarge the published set through the back door,
  // which is exactly the accident this feature exists to prevent.
  const plan = planPublishImport(
    publishConfig({ included: ['Notes'], excluded: [] }),
    rules({ includes: ['Notes'], excludes: ['Notes/Drafts'] }),
  )

  assert.deepEqual(plan.excludes, ['Notes/Drafts'])
  assert.deepEqual(plan.changes.filter((change) => change.list === 'excludes'), [
    { rule: 'Notes/Drafts', list: 'excludes', effect: 'kept' },
  ])
  assert.equal(plan.unchanged, true, 'and a kept exclude is not a change')
})

test("Publish's excludes are added on top of this vault's", () => {
  const plan = planPublishImport(
    publishConfig({ included: ['Notes'], excluded: ['Notes/Drafts', 'Ideas'] }),
    rules({ excludes: ['Ideas'] }),
  )

  assert.deepEqual(plan.excludes, ['Ideas', 'Notes/Drafts'], "this vault's first, then what Publish adds")
  assert.deepEqual(plan.changes.filter((change) => change.list === 'excludes'), [
    { rule: 'Ideas', list: 'excludes', effect: 'kept' },
    { rule: 'Notes/Drafts', list: 'excludes', effect: 'added' },
  ])
})

test('a rule both sides already have is kept, and listed once', () => {
  const plan = planPublishImport(
    publishConfig({ included: ['Notes', 'Ideas'] }),
    rules({ includes: ['Ideas'] }),
  )

  assert.deepEqual(plan.includes, ['Notes', 'Ideas'])
  assert.deepEqual(plan.changes.filter((change) => change.rule === 'Ideas'), [
    { rule: 'Ideas', list: 'includes', effect: 'kept' },
  ])
})

test('an empty include list, and a file with no filters at all, both leave nothing to import', () => {
  assert.equal(planPublishImport(publishConfig({ included: [] }), rules()).empty, true)
  assert.equal(planPublishImport(publishConfig({ hasFilters: false }), rules()).empty, true)
})

test('a configuration matching the vault is unchanged', () => {
  const plan = planPublishImport(
    publishConfig({ included: ['Notes'], excluded: ['Notes/Drafts'] }),
    rules({ includes: ['Notes'], excludes: ['Notes/Drafts'] }),
  )
  assert.equal(plan.unchanged, true)
  assert.equal(plan.empty, false)
})

test('a path in both lists survives in both, and the include reads zero', () => {
  // Publish resolves excludes before includes and so does `getPublishFlag`, so
  // keeping both is faithful rather than tidy.
  const plan = planPublishImport(publishConfig({ included: ['Notes'], excluded: ['Notes'] }), rules())
  assert.deepEqual(plan.includes, ['Notes'])
  assert.deepEqual(plan.excludes, ['Notes'])

  const after = summarize(plan)
  assert.equal(after.includes[0].count, 0)
  assert.equal(after.published, 0)
})

test('the plan never mutates its inputs', () => {
  const config = publishConfig({ included: ['Notes'], excluded: ['Notes/Drafts'] })
  const current = rules({ includes: ['Archive'], excludes: ['Ideas'] })
  const plan = planPublishImport(config, current)
  plan.includes.push('Mutated')
  plan.excludes.push('Mutated')

  assert.deepEqual(config.included, ['Notes'])
  assert.deepEqual(config.excluded, ['Notes/Drafts'])
  assert.deepEqual(current.includes, ['Archive'])
  assert.deepEqual(current.excludes, ['Ideas'])
})

// --- what it says ----------------------------------------------------------

test('the sentence leads with the number that matters', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules({ includes: ['Ideas'] }))
  assert.equal(
    importSentence(plan, 12, 93),
    'Your Obsidian Publish configuration lists 2 folders. Importing them publishes 93 notes instead of 12.',
  )
})

test('each empty-handed case gets its own sentence, because they send you to different places', () => {
  const noFilters = planPublishImport(publishConfig({ hasFilters: false }), rules())
  assert.match(importSentence(noFilters, 0, 0), /records no folder filters/)

  const perNote = planPublishImport(publishConfig({ included: [] }), rules())
  assert.match(importSentence(perNote, 0, 0), /selects notes individually/)
  assert.match(importSentence(perNote, 0, 0), /stored on Obsidian's servers/)

  const unchanged = planPublishImport(publishConfig({ included: ['Notes'] }), rules({ includes: ['Notes'] }))
  assert.match(importSentence(unchanged, 3, 3), /nothing to change/)
})

test('the button is labelled with the outcome, not the action', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules())
  assert.equal(importButtonLabel(plan, 93), 'Import 2 folders (93 notes)')
  assert.equal(importButtonLabel(planPublishImport(publishConfig(), rules()), 0), 'Import')
})

test('the confirmation counts the excludes, which step 6 cannot show', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes'], excluded: ['Notes/Drafts'] }), rules())
  assert.match(importedNotice(plan, 2), /Imported 1 folder from Obsidian Publish\. 2 notes will publish\./)
  assert.match(importedNotice(plan, 2), /1 folder was added to your excluded list/)

  const noExcludes = planPublishImport(publishConfig({ included: ['Notes'] }), rules())
  assert.doesNotMatch(importedNotice(noExcludes, 2), /excluded list/)
})

// --- warnings --------------------------------------------------------------

test('a blank entry is reported loudest, and says what a blank rule means', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes'] }), rules())
  const [first] = warnings(plan, { dropped: [{ list: 'included', raw: '', reason: 'blank' }] })
  assert.match(first, /named no folder/)
  assert.match(first, /matches every note in the vault/)
})

test('dot-folder entries and ignored ones are counted separately', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes'] }), rules())
  const said = warnings(plan, {
    dropped: [
      { list: 'included', raw: '.obsidian', reason: 'always-excluded' },
      { list: 'included', raw: 'Notes', reason: 'duplicate' },
      { list: 'included', raw: '42', reason: 'not-a-string' },
    ],
  })
  assert.match(said[0], /starting with a dot/)
  assert.match(said[1], /^2 entries were ignored/, 'duplicates fold into one line rather than earning one each')
})

test('dead folders are counted, and named as harmless', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Renamed', 'Gone'] }), rules())
  const [said] = warnings(plan)
  assert.match(said, /^2 of these folders no longer exist/)
  assert.match(said, /harmless/)
})

test('an include shadowed to zero by an exclude is explained', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes/Drafts'], excluded: ['Notes'] }), rules())
  assert.ok(
    warnings(plan).some((said) => /One included folder publishes nothing, because an excluded folder covers it/.test(said)),
  )
})

test('replacing this vault\'s includes is named, and only when something is actually lost', () => {
  const losing = planPublishImport(publishConfig({ included: ['Notes'] }), rules({ includes: ['Notes', 'Ideas'] }))
  assert.ok(warnings(losing).some((said) => /1 folder is not in your Publish configuration and stops publishing/.test(said)))

  const losingNothing = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules({ includes: ['Ideas'] }))
  assert.equal(warnings(losingNothing).some((said) => /stops? publishing/.test(said)), false)
})

test('a live site is warned about removals, and only about removals', () => {
  const losing = planPublishImport(publishConfig({ included: ['Notes'] }), rules({ includes: ['Notes', 'Ideas'] }))
  assert.ok(warnings(losing, { live: true }).some((said) => /taken off it on the next publish/.test(said)))
  assert.equal(warnings(losing, { live: false }).some((said) => /taken off it/.test(said)), false)

  const adding = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules({ includes: ['Notes'] }))
  assert.equal(
    warnings(adding, { live: true }).some((said) => /taken off it/.test(said)),
    false,
    'nothing stops publishing, so nothing comes off the site',
  )
})

test('a clean import says nothing at all', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules())
  assert.deepEqual(warnings(plan), [])
})
