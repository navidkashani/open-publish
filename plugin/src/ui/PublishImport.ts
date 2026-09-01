/**
 * What importing an Obsidian Publish configuration would do, in numbers and
 * sentences.
 *
 * Beside `FolderRules.ts` and for the reason its header already gives: no DOM
 * and no Obsidian import, so every number this dialog puts on screen is
 * produced by a function a plain-Node test can drive. Nothing here counts
 * anything itself. The caller runs the existing `summarizeRules` twice, once
 * over the vault's current rules and once over the plan, and hands both back.
 *
 * The one asymmetry worth reading before changing anything: **includes are
 * replaced, excludes are merged**. Publish's include list is the user's answer
 * to "what is public", so it replaces ours wholesale. Its exclude list is
 * usually empty, and replacing our excludes with an empty list would delete a
 * guard somebody added by hand, enlarging the published set through the back
 * door. That is precisely the accident this feature exists to prevent, so
 * excludes only ever gain entries.
 */

import type { PublishConfig, DroppedEntry } from '../core/publishconfig.ts'
import type { PublishFlag, SelectionRules } from '../core/selection.ts'
import { folderCountLabel, noteCountLabel } from './FolderRules.ts'
import type { RuleSummary } from './FolderRules.ts'

/**
 * Notes and attachments, counted apart.
 *
 * Kept apart for one reason, and it is a migration reason: somebody moving
 * across compares this screen's number against the one Obsidian Publish shows
 * them, and Publish counts notes and files separately. A single total is the
 * honest number and still the wrong answer to the question being asked. The
 * per-rule rows below stay on `summarizeRules`, which counts every publishable
 * file as a "note", so the two levels differ in wording while agreeing in
 * arithmetic.
 */
export interface PublishedCount {
  notes: number
  attachments: number
}

/** "93 notes and 2 attachments", said the way `upToDateStats` says it. */
export function publishedCountLabel(count: PublishedCount): string {
  const parts: string[] = []
  if (count.notes > 0) parts.push(noteCountLabel(count.notes))
  if (count.attachments > 0) {
    parts.push(`${count.attachments} ${count.attachments === 1 ? 'attachment' : 'attachments'}`)
  }
  return parts.length > 0 ? parts.join(' and ') : 'nothing'
}

const totalOf = (count: PublishedCount): number => count.notes + count.attachments

export interface RuleChange {
  rule: string
  list: 'includes' | 'excludes'
  effect: 'added' | 'kept' | 'removed'
}

export interface ImportPlan {
  /** Publish's list, replacing this vault's. */
  includes: string[]
  /** This vault's, plus any of Publish's it lacks. */
  excludes: string[]
  changes: RuleChange[]
  unchanged: boolean
  /** Nothing to import: no folder filters at all, or an empty include list. */
  empty: boolean
  /**
   * Carried through from the configuration because the two empty-handed cases
   * need different sentences, and sending somebody hunting for a file that was
   * never going to be there is the failure this avoids.
   */
  hasFilters: boolean
}

/** Never mutates its inputs: the invariant `addRule` and `removeRule` are already tested for. */
export function planPublishImport(config: PublishConfig, current: SelectionRules): ImportPlan {
  const includes = [...config.included]
  const excludes = [...current.excludes]
  for (const rule of config.excluded) {
    if (!excludes.includes(rule)) excludes.push(rule)
  }

  const changes: RuleChange[] = []
  for (const rule of includes) {
    changes.push({ rule, list: 'includes', effect: current.includes.includes(rule) ? 'kept' : 'added' })
  }
  for (const rule of current.includes) {
    if (!includes.includes(rule)) changes.push({ rule, list: 'includes', effect: 'removed' })
  }
  for (const rule of excludes) {
    changes.push({ rule, list: 'excludes', effect: current.excludes.includes(rule) ? 'kept' : 'added' })
  }

  return {
    includes,
    excludes,
    changes,
    // Nothing added and nothing removed. An exclude can never be removed here,
    // so this is the whole of "the vault already says what the file says".
    unchanged: changes.every((change) => change.effect === 'kept'),
    empty: !config.hasFilters || config.included.length === 0,
    hasFilters: config.hasFilters,
  }
}

/** What a row's effect is called on screen. Kept here so the words cannot drift. */
export function effectLabel(effect: RuleChange['effect']): string {
  switch (effect) {
    case 'added':
      return 'added'
    case 'kept':
      return 'already listed'
    case 'removed':
      return 'no longer published'
  }
}

/**
 * The opening line, and the number that matters.
 *
 * `before` and `after` are note counts resolved through `getPublishFlag`, so
 * they are what a publish would actually produce rather than what the folder
 * rules select on their own.
 */
export function importSentence(plan: ImportPlan, before: PublishedCount, after: PublishedCount): string {
  if (!plan.hasFilters) {
    return (
      'This vault has an Obsidian Publish site but records no folder filters, so there is nothing to import. ' +
      'Add folders below.'
    )
  }
  if (plan.empty) return PER_NOTE_SELECTIONS_UNREACHABLE
  const lists = `Your Obsidian Publish configuration lists ${folderCountLabel(plan.includes.length)}.`
  if (plan.unchanged) return `${lists} They are the folders this vault already publishes, so there is nothing to change.`
  if (totalOf(before) === totalOf(after)) {
    return `${lists} Importing them publishes ${publishedCountLabel(after)}, as much as now.`
  }
  return `${lists} Importing them publishes ${publishedCountLabel(after)} instead of ${publishedCountLabel(before)}.`
}

/** The outcome, not the action, the same habit as the wizard's counted Copy button. */
export function importButtonLabel(plan: ImportPlan, after: PublishedCount, ticked = 0): string {
  // With folders to import, the count in brackets already moves as notes are
  // ticked. Without them there is no other number on screen, so the notes are
  // the whole of what pressing this does.
  if (plan.empty || plan.unchanged) return ticked > 0 ? `Import ${noteCountLabel(ticked)}` : 'Import'
  return `Import ${folderCountLabel(plan.includes.length)} (${publishedCountLabel(after)})`
}

/**
 * Why Import is disabled, said in the modal rather than left to be guessed at.
 * Null when it is not.
 */
export function importBlockedReason(plan: ImportPlan, ticked = 0): string | null {
  // A ticked note is something to do whatever the folder plan says, and the
  // empty plan is the case where that matters most: a site that selected every
  // note by hand has an empty include list and would otherwise be a dead end.
  if (ticked > 0) return null
  if (plan.empty) return 'There are no folders to import.'
  if (plan.unchanged) return 'Your folders already match this configuration.'
  return null
}

/**
 * The confirmation, said out loud because one entry point cannot show it.
 *
 * Step 6 of the setup guide renders the *includes* list alone, so an import
 * that also set excludes would apply them invisibly there. The count goes in
 * the sentence for that reason.
 */
export function importedNotice(plan: ImportPlan, after: PublishedCount, ticked = 0): string {
  const said: string[] = []
  // An empty plan writes no folders at all, so claiming "Imported 0 folders"
  // would describe a write that did not happen.
  if (!plan.empty) said.push(`Imported ${folderCountLabel(plan.includes.length)} from Obsidian Publish.`)
  if (ticked > 0) {
    said.push(`${capitalize(noteCountLabel(ticked))} ${ticked === 1 ? 'was' : 'were'} added individually.`)
  }
  said.push(`${capitalize(publishedCountLabel(after))} will publish.`)

  const excludesAdded = plan.changes.filter((change) => change.list === 'excludes' && change.effect === 'added').length
  if (excludesAdded > 0 && !plan.empty) {
    said.push(
      `${capitalize(folderCountLabel(excludesAdded))} ${excludesAdded === 1 ? 'was' : 'were'} added to your excluded list.`,
    )
  }
  return said.join(' ')
}

/**
 * Everything the preview has to say out loud, loudest first.
 *
 * `string[]` rather than something richer so it drops straight into
 * `ScanNotices`' `readonly string[]` shape and renders with the same
 * `op-notice-warning` box people already know.
 */
export function importWarnings(input: {
  plan: ImportPlan
  /** `summarizeRules` over the planned rules. */
  after: RuleSummary
  dropped: readonly DroppedEntry[]
  /** Whether this vault has published before. See `lastPublishedAt`. */
  live: boolean
}): string[] {
  const { plan, after, dropped } = input
  const warnings: string[] = []

  // Loudest, because it is the one that would have published everything.
  const blank = dropped.filter((entry) => entry.reason === 'blank').length
  if (blank > 0) {
    warnings.push(
      blank === 1
        ? 'One entry in your Publish configuration named no folder. A blank rule matches every note in the vault, ' +
          'so it was left out.'
        : `${blank} entries in your Publish configuration named no folder. A blank rule matches every note in the ` +
          'vault, so they were left out.',
    )
  }

  const dotted = dropped.filter((entry) => entry.reason === 'always-excluded').length
  if (dotted > 0) {
    warnings.push(
      dotted === 1
        ? 'One entry named a folder starting with a dot. Nothing inside one is ever published, so it was left out.'
        : `${dotted} entries named a folder starting with a dot. Nothing inside one is ever published, so they were left out.`,
    )
  }

  // Duplicates and stray values fold into one line: a file with six repeats is
  // not six problems.
  const ignored = dropped.filter(
    (entry) => entry.reason === 'duplicate' || entry.reason === 'not-a-string',
  ).length
  if (ignored > 0) {
    warnings.push(
      ignored === 1
        ? 'One entry was ignored: it was listed twice, or it was not a folder name.'
        : `${ignored} entries were ignored: they were listed twice, or they were not folder names.`,
    )
  }

  const dead = [...after.includes, ...after.excludes].filter((stat) => !stat.exists).length
  if (dead > 0) {
    warnings.push(
      dead === 1
        ? 'One of these folders no longer exists in this vault, probably renamed since Publish last saved. ' +
          'It publishes nothing, so it is harmless to leave.'
        : `${dead} of these folders no longer exist in this vault, probably renamed since Publish last saved. ` +
          'They publish nothing, so they are harmless to leave.',
    )
  }

  // A dead rule already reads 0 and is covered above, so only live-but-shadowed
  // rules count here.
  const shadowed = after.includes.filter((stat) => stat.exists && stat.count === 0).length
  if (shadowed > 0) {
    warnings.push(
      shadowed === 1
        ? 'One included folder publishes nothing, because an excluded folder covers it.'
        : `${shadowed} included folders publish nothing, because an excluded folder covers them.`,
    )
  }

  // An empty plan writes no folders at all, so nothing it lists as "removed"
  // is actually removed: `commit` leaves both lists alone there. Warning about
  // it would describe a write that cannot happen.
  const removed = plan.empty ? 0 : plan.changes.filter((change) => change.effect === 'removed').length
  if (removed > 0) {
    warnings.push(
      `This replaces the folders this vault publishes now. ${capitalize(folderCountLabel(removed))} ` +
        `${removed === 1 ? 'is' : 'are'} not in your Publish configuration and ${removed === 1 ? 'stops' : 'stop'} publishing.`,
    )
  }

  // A state rather than an event, the same way `storageMovedWarning` and
  // `rollbackWarning` are: this stays true until the next publish resolves it.
  if (input.live && removed > 0) {
    warnings.push(
      'This site has been published already, so notes that stop matching are taken off it on the next publish.',
    )
  }

  return warnings
}

/** The safety asymmetry, on screen, in one sentence. */
export const EXCLUDES_KEPT_NOTE =
  'Your excluded folders are kept. An excluded folder can only ever publish less, so importing never removes one.'

/** The URL note, consistent with `SettingsTab.renderUrlStyle` and `docs/architecture.md`. */
export const LEGACY_URL_OFFER =
  'Obsidian Publish served "Company/About us.md" at /Company/About+us. Here the same note lives at ' +
  '/company/about-us. If you are keeping the domain Publish served, this puts a redirect at every old address so ' +
  'existing links and search results still arrive. It cannot help with links to publish.obsidian.md.'

export const LEGACY_URL_TOGGLE = 'Keep the URLs Obsidian Publish gave this site'

// --- notes Publish published one at a time ---------------------------------

/**
 * Where per-note selections live, and why this plugin cannot read them.
 *
 * The second half is the load-bearing half. Those selections are *publicly*
 * readable: a Publish site's own HTML names the endpoints that return them, and
 * both answer without authentication. So "they cannot be imported" was never
 * true. The plugin declines to look, because its promise is that nothing passes
 * through anyone else's server, and it should say so rather than plead
 * ignorance to somebody who has opened their own site's HTML.
 * `docs/architecture.md` records the endpoints and the decision.
 */
export const PER_NOTE_SELECTIONS_UNREACHABLE =
  'Your Publish site selects notes individually rather than by folder. Those choices live on Obsidian\'s ' +
  'servers rather than in your vault, and this plugin does not talk to Obsidian, so it cannot see them.'

/** A note carrying a permalink that the imported rules would not publish. */
export interface UnclaimedPermalink {
  path: string
  permalink: string
}

/**
 * Candidates for "Publish served this one individually".
 *
 * `flag` is `getPublishFlag` under the *planned* rules, and only `null`
 * qualifies. `true` is already covered by a folder, and `false` is a refusal
 * already recorded, either `publish: false` in frontmatter or an excluded
 * folder, which this must never offer to overturn.
 *
 * A permalink is evidence, not proof: it is a note saying "I have a fixed
 * public address", which is a thing people write on notes they publish. On the
 * one real vault this was measured against, four notes carry one, all four were
 * published, and three of those were selected individually. Good evidence and a
 * poor rule, which is why the caller offers these with the boxes empty.
 *
 * Non-strings, blank strings and whitespace are dropped here rather than in the
 * caller: a blank permalink never moved a URL, so it says nothing either way.
 */
export function unclaimedPermalinks(
  notes: readonly { path: string; permalink: unknown; flag: PublishFlag }[],
): UnclaimedPermalink[] {
  const found: UnclaimedPermalink[] = []
  for (const note of notes) {
    if (note.flag !== null) continue
    if (typeof note.permalink !== 'string') continue
    const permalink = note.permalink.trim()
    if (permalink === '') continue
    found.push({ path: note.path, permalink })
  }
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * How many of them are worth putting on screen.
 *
 * A vault with hundreds of unclaimed permalinks is one where the inference is
 * weak anyway, since somebody who puts a permalink on everything is not telling
 * us what Publish served, and a preview that cannot be read is not a preview.
 */
export const UNCLAIMED_PERMALINK_LIMIT = 25

/** What stands in for the rows past the cap. Null when they all fit. */
export function unclaimedRemainderNote(total: number): string | null {
  const hidden = total - UNCLAIMED_PERMALINK_LIMIT
  if (hidden <= 0) return null
  return (
    `${hidden} more ${hidden === 1 ? 'note carries' : 'notes carry'} a permalink and ${hidden === 1 ? 'is' : 'are'} ` +
    'not listed. When this many notes have one, a permalink stops saying anything about Obsidian Publish. Any of ' +
    'them can be published on its own from the note\'s right-click menu.'
  )
}

export const UNCLAIMED_PERMALINK_HEADING = 'Notes that may have been published individually'

/** The inference and its limit, in the same breath. */
export const UNCLAIMED_PERMALINK_OFFER =
  'Obsidian Publish also lets you publish single notes, and it keeps those choices on its own servers rather ' +
  'than in your vault. These notes carry a permalink, which usually means Publish served them. Tick any that ' +
  'belong on your site.'

export const UNCLAIMED_PERMALINK_BLIND_SPOT =
  'A note that Publish published individually without a permalink cannot be found this way. Compare against ' +
  'your live site if you want to be sure.'

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
