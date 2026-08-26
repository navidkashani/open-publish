/**
 * The number beside a rule is the whole reason the dialog beats a text box, so
 * it is the thing most worth being sure of. Every case here is one someone
 * actually hits: a folder renamed underneath a rule, an exclude that quietly
 * swallows an include, a rule typed with slashes around it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEAD_RULE_WARNING,
  addRule,
  folderRulesSentence,
  folderRulesSummary,
  noteCountLabel,
  normalizeFolderRule,
  removeRule,
  summarizeRules,
} from '../src/ui/FolderRules.ts'

const FILES = [
  'Notes/Luhmann.md',
  'Notes/Zettelkasten.md',
  'Notes/Drafts/Half thought.md',
  'Notes/Drafts/Later.md',
  'Ideas/WIP.md',
  'Archive/2024/Old.md',
  '.obsidian/plugins/open-publish/data.json',
  '.trash/Deleted.md',
  'Notes/notes.txt',
  'attachments/diagram.png',
]

const everyFolder = (path) => !path.startsWith('Gone')

function summarize(includes, excludes, folderExists = everyFolder) {
  return summarizeRules({ files: FILES, includes, excludes, folderExists })
}

test('a rule counts the notes it publishes', () => {
  const summary = summarize(['Notes'], [])
  assert.deepEqual(summary.includes, [{ rule: 'Notes', count: 4, exists: true }])
  assert.equal(summary.published, 4)
})

test('unsupported files and dot-folders never count towards a rule', () => {
  // "Notes/notes.txt" is inside the rule and is not published; ".obsidian" and
  // ".trash" are excluded unconditionally, whatever anyone types.
  assert.equal(summarize(['Notes'], []).includes[0].count, 4)
  assert.equal(summarize([''], []).published, 7, 'attachments and the png count, the dot-folders do not')
  assert.equal(summarize(['.obsidian'], []).includes[0].count, 0)
  assert.equal(summarize(['.trash'], []).includes[0].count, 0)
})

test('an include shadowed by an exclude reads zero, which is the point', () => {
  const summary = summarize(['Notes/Drafts'], ['Notes'])
  assert.equal(summary.includes[0].count, 0, 'excludes are checked first, so this publishes nothing')
  assert.equal(summary.published, 0)
})

test('a partial exclude leaves the include counting only what survives', () => {
  const summary = summarize(['Notes'], ['Notes/Drafts'])
  assert.equal(summary.includes[0].count, 2, 'the two drafts are gone')
  assert.equal(summary.excludes[0].count, 2, 'and the exclude says how many it is holding back')
  assert.equal(summary.published, 2)
})

test('an exclude that holds nothing back reads zero, the same as a dead include', () => {
  // Nothing includes "Archive", so excluding it is doing no work at all.
  assert.equal(summarize(['Notes'], ['Archive']).excludes[0].count, 0)
})

test('overlapping includes each report what they publish, and the total does not double-count', () => {
  const summary = summarize(['Notes', 'Notes/Drafts'], [])
  assert.deepEqual(
    summary.includes.map((stat) => stat.count),
    [4, 2],
  )
  assert.equal(summary.published, 4, 'the same four notes, however many rules name them')
})

test('a folder renamed out from under a rule is reported, not silently ignored', () => {
  const summary = summarize(['Gone/Old name'], [])
  assert.deepEqual(summary.includes, [{ rule: 'Gone/Old name', count: 0, exists: false }])
  assert.equal(DEAD_RULE_WARNING, 'This folder no longer exists')
})

test('a rule for a folder that exists but is empty is not mistaken for a dead one', () => {
  const summary = summarize(['Empty'], [])
  assert.deepEqual(summary.includes, [{ rule: 'Empty', count: 0, exists: true }])
})

test('rules are normalised the way the scanner reads them', () => {
  assert.equal(normalizeFolderRule('  /Notes/  '), 'Notes')
  assert.equal(normalizeFolderRule('Notes/Drafts'), 'Notes/Drafts')
  assert.equal(normalizeFolderRule('///'), '')
  assert.equal(normalizeFolderRule('   '), '')
})

test('adding is idempotent, and an empty rule is never added', () => {
  assert.deepEqual(addRule([], 'Notes'), ['Notes'])
  assert.deepEqual(addRule(['Notes'], '/Notes/'), ['Notes'], 'the same folder, differently typed')
  assert.deepEqual(addRule(['Notes'], '   '), ['Notes'])
  // An empty rule matches the entire vault (`matchesFolderRule`), so it must not
  // be reachable by pressing Enter on a blank box.
  assert.deepEqual(addRule(['Notes'], '/'), ['Notes'])
  assert.deepEqual(addRule(['Notes'], 'Ideas'), ['Notes', 'Ideas'])
})

test('adding and removing never mutate the list they were given', () => {
  const rules = ['Notes']
  addRule(rules, 'Ideas')
  removeRule(rules, 'Notes')
  assert.deepEqual(rules, ['Notes'])
})

test('removing a rule that is not there changes nothing', () => {
  assert.deepEqual(removeRule(['Notes'], 'Ideas'), ['Notes'])
  assert.deepEqual(removeRule(['Notes', 'Ideas'], 'Notes'), ['Ideas'])
})

test('counts survive a vault far larger than the rules', () => {
  const files = Array.from({ length: 20_000 }, (_, index) => `Notes/${index % 40}/Note ${index}.md`)
  const includes = Array.from({ length: 10 }, (_, index) => `Notes/${index}`)
  const summary = summarizeRules({ files, includes, excludes: ['Notes/3'], folderExists: () => true })
  assert.equal(summary.includes[0].count, 500)
  assert.equal(summary.includes[3].count, 0, 'excluded outright')
  assert.equal(summary.published, 4500)
})

test('the sentences count things the way people say them', () => {
  assert.equal(noteCountLabel(0), '0 notes')
  assert.equal(noteCountLabel(1), '1 note')
  assert.equal(noteCountLabel(12), '12 notes')

  assert.match(folderRulesSentence(summarize([], [])), /No folder rules yet/)
  assert.equal(folderRulesSentence(summarize(['Notes'], [])), 'Open Publish is including 1 folder.')
  assert.equal(
    folderRulesSentence(summarize(['Notes', 'Ideas'], ['Notes/Drafts'])),
    'Open Publish is including 2 folders and excluding 1.',
  )

  assert.match(folderRulesSummary(summarize([], [])), /None yet/)
  assert.equal(folderRulesSummary(summarize(['Notes'], [])), '1 included · 4 notes published')
  assert.equal(folderRulesSummary(summarize(['Notes'], ['Notes/Drafts'])), '1 included · 1 excluded · 2 notes published')
})
