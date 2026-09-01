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
  UNCLAIMED_PERMALINK_BLIND_SPOT,
  UNCLAIMED_PERMALINK_LIMIT,
  importBlockedReason,
  importButtonLabel,
  publishedCountLabel,
  importSentence,
  importWarnings,
  importedNotice,
  planPublishImport,
  unclaimedPermalinks,
  unclaimedRemainderNote,
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
    importSentence(plan, { notes: 12, attachments: 0 }, { notes: 93, attachments: 0 }),
    'Your Obsidian Publish configuration lists 2 folders. Importing them publishes 93 notes instead of 12 notes.',
  )
})

test('notes and attachments are counted apart, because Publish counts them apart', () => {
  // Somebody migrating compares this against the number Obsidian Publish shows
  // them. "95 notes" is the honest total and still the wrong answer.
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules())
  assert.match(
    importSentence(plan, { notes: 0, attachments: 0 }, { notes: 93, attachments: 2 }),
    /publishes 93 notes and 2 attachments instead of nothing\./,
  )
  assert.equal(publishedCountLabel({ notes: 1, attachments: 1 }), '1 note and 1 attachment')
  assert.equal(publishedCountLabel({ notes: 0, attachments: 2 }), '2 attachments')
  assert.equal(publishedCountLabel({ notes: 0, attachments: 0 }), 'nothing')
})

test('each empty-handed case gets its own sentence, because they send you to different places', () => {
  const none = { notes: 0, attachments: 0 }
  const noFilters = planPublishImport(publishConfig({ hasFilters: false }), rules())
  assert.match(importSentence(noFilters, none, none), /records no folder filters/)

  const perNote = planPublishImport(publishConfig({ included: [] }), rules())
  assert.match(importSentence(perNote, none, none), /selects notes individually/)
  assert.match(importSentence(perNote, none, none), /live on Obsidian's servers rather than in your vault/)
  // Not "cannot be imported", which was never true: those selections are
  // publicly readable, and this plugin declines to look. See architecture.md.
  assert.match(importSentence(perNote, none, none), /this plugin does not talk to Obsidian, so it cannot see them/)

  const three = { notes: 3, attachments: 0 }
  const unchanged = planPublishImport(publishConfig({ included: ['Notes'] }), rules({ includes: ['Notes'] }))
  assert.match(importSentence(unchanged, three, three), /nothing to change/)
})

test('the button is labelled with the outcome, not the action', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes', 'Ideas'] }), rules())
  assert.equal(importButtonLabel(plan, { notes: 93, attachments: 2 }), 'Import 2 folders (93 notes and 2 attachments)')
  assert.equal(importButtonLabel(planPublishImport(publishConfig(), rules()), { notes: 0, attachments: 0 }), 'Import')
})

test('the confirmation counts the excludes, which step 6 cannot show', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes'], excluded: ['Notes/Drafts'] }), rules())
  const two = { notes: 2, attachments: 0 }
  assert.match(importedNotice(plan, two), /Imported 1 folder from Obsidian Publish\. 2 notes will publish\./)
  assert.match(importedNotice(plan, two), /1 folder was added to your excluded list/)

  const noExcludes = planPublishImport(publishConfig({ included: ['Notes'] }), rules())
  assert.doesNotMatch(importedNotice(noExcludes, two), /excluded list/)
})

// --- notes Publish may have published one at a time ------------------------

/** One note as the modal hands it over: a path, a raw permalink, a resolved flag. */
const note = (path, permalink, flag = null) => ({ path, permalink, flag })

test('a permalink on a note the imported rules do not publish is offered', () => {
  // The measured case: three root notes outside every folder in publish.json,
  // each carrying the permalink Publish served it at.
  assert.deepEqual(
    unclaimedPermalinks([
      note('Welcome.md', 'welcome'),
      note('Now.md', 'now'),
      note('Start here.md', 'start'),
    ]),
    [
      { path: 'Now.md', permalink: 'now' },
      { path: 'Start here.md', permalink: 'start' },
      { path: 'Welcome.md', permalink: 'welcome' },
    ],
    'sorted by path, so two runs over one vault agree',
  )
})

test('a note that already publishes is not offered, and an explicit refusal is never overturned', () => {
  // `false` is the one that matters: a note saying publish: false, or one
  // inside an excluded folder, has an answer already, and this must never
  // offer to reverse it. `true` is merely redundant: a folder covers it.
  assert.deepEqual(unclaimedPermalinks([note('About/About.md', 'about', true)]), [])
  assert.deepEqual(unclaimedPermalinks([note('Private/Diary.md', 'diary', false)]), [])
})

test('a permalink that is not a usable string is no evidence at all', () => {
  // A blank permalink never moved a URL (`slugForPath` ignores it), so it says
  // nothing about whether Publish served the note.
  assert.deepEqual(
    unclaimedPermalinks([
      note('Blank.md', ''),
      note('Spaces.md', '   '),
      note('Number.md', 42),
      note('List.md', ['a', 'b']),
      note('Missing.md', undefined),
      note('Null.md', null),
    ]),
    [],
  )
  assert.deepEqual(unclaimedPermalinks([note('Padded.md', '  welcome  ')]), [
    { path: 'Padded.md', permalink: 'welcome' },
  ])
})

test('one ticked note is enough to unblock an import with no folders in it', () => {
  // The site that selected every note by hand: an empty include list, and
  // until now a dead end with nothing to press.
  const perNote = planPublishImport(publishConfig({ included: [] }), rules())
  assert.equal(importBlockedReason(perNote), 'There are no folders to import.')
  assert.equal(importBlockedReason(perNote, 1), null)
  assert.equal(importButtonLabel(perNote, { notes: 1, attachments: 0 }, 1), 'Import 1 note')

  const unchanged = planPublishImport(publishConfig({ included: ['Notes'] }), rules({ includes: ['Notes'] }))
  assert.equal(importBlockedReason(unchanged), 'Your folders already match this configuration.')
  assert.equal(importBlockedReason(unchanged, 2), null)
})

test('an empty plan warns about no removals, because it writes no folders', () => {
  // Import is reachable there now, and it leaves both rule lists alone. A
  // warning that folders stop publishing would describe a write that cannot
  // happen.
  const perNote = planPublishImport(publishConfig({ included: [] }), rules({ includes: ['Notes'] }))
  assert.equal(warnings(perNote, { live: true }).some((said) => /stops? publishing|taken off it/.test(said)), false)
})

test('the confirmation counts the notes apart from the folders', () => {
  const plan = planPublishImport(publishConfig({ included: ['Notes'] }), rules())
  const five = { notes: 5, attachments: 0 }
  assert.match(importedNotice(plan, five, 2), /Imported 1 folder from Obsidian Publish\./)
  assert.match(importedNotice(plan, five, 2), /2 notes were added individually\./)

  const perNote = planPublishImport(publishConfig({ included: [] }), rules())
  const one = { notes: 1, attachments: 0 }
  assert.doesNotMatch(importedNotice(perNote, one, 1), /folder/, 'no folders were written, so none are claimed')
  assert.match(importedNotice(perNote, one, 1), /1 note was added individually\. 1 note will publish\./)
})

test('past the cap the rest are named rather than listed', () => {
  // Somebody who puts a permalink on everything is not telling us what Publish
  // served, and a preview that cannot be read is not a preview.
  assert.equal(unclaimedRemainderNote(UNCLAIMED_PERMALINK_LIMIT), null)
  assert.equal(
    unclaimedRemainderNote(UNCLAIMED_PERMALINK_LIMIT + 1),
    '1 more note carries a permalink and is not listed. When this many notes have one, a permalink stops saying ' +
      "anything about Obsidian Publish. Any of them can be published on its own from the note's right-click menu.",
  )
  assert.match(
    unclaimedRemainderNote(UNCLAIMED_PERMALINK_LIMIT + 15),
    /^15 more notes carry a permalink and are not listed\./,
  )
})

test('the offer says out loud what it cannot see', () => {
  assert.match(UNCLAIMED_PERMALINK_BLIND_SPOT, /without a permalink cannot be found this way/)
  assert.match(UNCLAIMED_PERMALINK_BLIND_SPOT, /Compare against your live site/)
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
