/**
 * Folder-rule arithmetic: normalisation, counts, dead-rule detection.
 *
 * No DOM and no Obsidian, so the numbers the dialog shows can be tested under
 * plain Node and, more importantly, so they are computed by the *same*
 * functions the scanner uses. `matchesFolderRule`, `isAlwaysExcluded` and
 * `isSupportedFile` come straight from `core/selection.ts`; nothing here
 * reimplements matching, so the count beside a rule cannot drift from what a
 * publish will actually do.
 *
 * One boundary worth naming: these counts describe what the *folder rules*
 * select. Frontmatter and per-file choices outrank folder rules for individual
 * notes (`getPublishFlag`), and consulting them would mean reading the metadata
 * cache for every file in the vault on every keystroke-free refresh. The rules
 * are what this dialog edits, so the rules are what it counts.
 */

import { isAlwaysExcluded, isSupportedFile, matchesFolderRule, normalizeFolderRule } from '../core/selection.ts'

/**
 * Re-exported, not defined here.
 *
 * It moved down beside `matchesFolderRule`, the function it has to agree with,
 * so that `core/publishconfig.ts` can normalise a foreign file's folder list
 * without a `core/` module importing from `ui/`. Every existing caller still
 * reads it from here.
 */
export { normalizeFolderRule }

export interface RuleStat {
  rule: string
  /**
   * For an include: notes published *because of* this rule, already net of
   * every exclude, so a fully shadowed include reads 0. For an exclude: notes
   * it is holding back, i.e. ones an include would otherwise publish.
   */
  count: number
  /** False once the folder has been renamed or deleted out from under the rule. */
  exists: boolean
}

export interface RuleSummary {
  includes: RuleStat[]
  excludes: RuleStat[]
  /** Notes the two lists publish between them. */
  published: number
}

export interface SummarizeInput {
  /** Every file path in the vault. Walked once per rule. */
  files: readonly string[]
  includes: readonly string[]
  excludes: readonly string[]
  /** Vault lookup, so a renamed folder can be reported rather than silently matching nothing. */
  folderExists: (path: string) => boolean
}

/** Append a rule unless it is empty or already listed. Returns a new array. */
export function addRule(rules: readonly string[], rule: string): string[] {
  const normalized = normalizeFolderRule(rule)
  if (!normalized || rules.includes(normalized)) return [...rules]
  return [...rules, normalized]
}

export function removeRule(rules: readonly string[], rule: string): string[] {
  return rules.filter((existing) => existing !== rule)
}

export function summarizeRules(input: SummarizeInput): RuleSummary {
  const { includes, excludes, folderExists } = input

  // Files that could never publish regardless of the rules are dropped once,
  // up front, so no rule takes credit for them.
  const candidates = input.files.filter((path) => isSupportedFile(path) && !isAlwaysExcluded(path))

  const isExcluded = candidates.map((path) => excludes.some((rule) => matchesFolderRule(path, rule)))
  const isIncluded = candidates.map((path) => includes.some((rule) => matchesFolderRule(path, rule)))

  const statFor = (rule: string, countsWhen: (index: number) => boolean): RuleStat => {
    let count = 0
    for (const [index, path] of candidates.entries()) {
      if (matchesFolderRule(path, rule) && countsWhen(index)) count++
    }
    return { rule, count, exists: folderExists(rule) }
  }

  return {
    includes: includes.map((rule) => statFor(rule, (index) => !isExcluded[index])),
    // An exclude that shadows nothing an include would have published is doing
    // no work, and reads 0: the same signal as a dead include.
    excludes: excludes.map((rule) => statFor(rule, (index) => isIncluded[index] === true)),
    published: candidates.filter((_, index) => isIncluded[index] && !isExcluded[index]).length,
  }
}

// --- sentences -------------------------------------------------------------

export function noteCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'note' : 'notes'}`
}

/** Shared with the Publish import, which counts the same things in the same words. */
export function folderCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'folder' : 'folders'}`
}

/** The dialog's opening line. */
export function folderRulesSentence(summary: RuleSummary): string {
  const { includes, excludes } = summary
  if (includes.length === 0 && excludes.length === 0) {
    return 'No folder rules yet. Nothing is published by folder until you add one.'
  }
  if (excludes.length === 0) {
    return `Open Publish is including ${folderCountLabel(includes.length)}.`
  }
  return `Open Publish is including ${folderCountLabel(includes.length)} and excluding ${excludes.length}.`
}

/** The settings summary row, which has to say the same thing in a third of the width. */
export function folderRulesSummary(summary: RuleSummary): string {
  if (summary.includes.length === 0 && summary.excludes.length === 0) {
    return 'None yet. Nothing is published by folder.'
  }
  const parts = [`${summary.includes.length} included`]
  if (summary.excludes.length > 0) parts.push(`${summary.excludes.length} excluded`)
  parts.push(`${noteCountLabel(summary.published)} published`)
  return parts.join(' · ')
}

export const DEAD_RULE_WARNING = 'This folder no longer exists'
