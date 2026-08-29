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
import type { SelectionRules } from '../core/selection.ts'
import { folderCountLabel, noteCountLabel } from './FolderRules.ts'
import type { RuleSummary } from './FolderRules.ts'

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
export function importSentence(plan: ImportPlan, before: number, after: number): string {
  if (!plan.hasFilters) {
    return (
      'This vault has an Obsidian Publish site but records no folder filters, so there is nothing to import. ' +
      'Add folders below.'
    )
  }
  if (plan.empty) {
    return (
      'Your Publish site selects notes individually rather than by folder. Those choices are stored on ' +
      "Obsidian's servers, not in your vault, so they cannot be imported."
    )
  }
  const lists = `Your Obsidian Publish configuration lists ${folderCountLabel(plan.includes.length)}.`
  if (plan.unchanged) return `${lists} They are the folders this vault already publishes, so there is nothing to change.`
  if (before === after) return `${lists} Importing them publishes ${noteCountLabel(after)}, as many as now.`
  return `${lists} Importing them publishes ${noteCountLabel(after)} instead of ${before}.`
}

/** The outcome, not the action, the same habit as the wizard's counted Copy button. */
export function importButtonLabel(plan: ImportPlan, after: number): string {
  if (plan.empty || plan.unchanged) return 'Import'
  return `Import ${folderCountLabel(plan.includes.length)} (${noteCountLabel(after)})`
}

/**
 * Why Import is disabled, said in the modal rather than left to be guessed at.
 * Null when it is not.
 */
export function importBlockedReason(plan: ImportPlan): string | null {
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
export function importedNotice(plan: ImportPlan, after: number): string {
  const excludesAdded = plan.changes.filter((change) => change.list === 'excludes' && change.effect === 'added').length
  const published = `Imported ${folderCountLabel(plan.includes.length)} from Obsidian Publish. ${capitalize(
    noteCountLabel(after),
  )} will publish.`
  if (excludesAdded === 0) return published
  return `${published} ${capitalize(folderCountLabel(excludesAdded))} ${excludesAdded === 1 ? 'was' : 'were'} added to your excluded list.`
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

  const removed = plan.changes.filter((change) => change.effect === 'removed').length
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
