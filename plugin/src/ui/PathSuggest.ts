/**
 * A picker over vault paths, for the places that used to be free text.
 *
 * `AbstractInputSuggest` is the same base Obsidian's own path inputs use, and
 * `prepareFuzzySearch` + `sortSearchResults` + `renderResults` are the same
 * three functions behind the quick switcher, so the ranking and the character
 * highlighting match what people already expect from the app, rather than being
 * a second, nearly-right implementation of both.
 *
 * Typing a path that does not exist stays allowed. Obsidian Publish permits it
 * for folders that have not been created yet, and forbidding it would mean a
 * rule could not be written before the folder it names. The row that results
 * says so instead.
 */

import { AbstractInputSuggest, normalizePath, prepareFuzzySearch, renderResults, sortSearchResults } from 'obsidian'
import type { App, SearchResult } from 'obsidian'
import { normalizeFolderRule } from './FolderRules.ts'

export interface PathSuggestOptions {
  /**
   * Every candidate path, recomputed per query rather than captured once: a
   * folder added while the dialog is open should be offerable without a reopen,
   * and the exclusion list changes as rows are added.
   */
  items: () => string[]
  onPick: (path: string) => void
}

interface Ranked {
  path: string
  match: SearchResult
}

export class PathSuggest extends AbstractInputSuggest<string> {
  private readonly matches = new Map<string, SearchResult>()
  private readonly options: PathSuggestOptions

  constructor(app: App, input: HTMLInputElement, options: PathSuggestOptions) {
    super(app, input)
    this.options = options
  }

  protected override getSuggestions(query: string): string[] {
    this.matches.clear()
    const items = this.options.items()
    const trimmed = query.trim()
    if (!trimmed) return items

    const search = prepareFuzzySearch(trimmed)
    const ranked: Ranked[] = []
    for (const path of items) {
      const match = search(path)
      if (match) ranked.push({ path, match })
    }
    sortSearchResults(ranked)
    for (const entry of ranked) this.matches.set(entry.path, entry.match)
    return ranked.map((entry) => entry.path)
  }

  override renderSuggestion(value: string, el: HTMLElement): void {
    const match = this.matches.get(value)
    if (match) renderResults(el, value, match)
    else el.setText(value)
  }

  override selectSuggestion(value: string): void {
    // `setValue` writes the input without firing `input`, so the component's own
    // onChange never runs, which is why picking reports through `onPick` rather
    // than leaving the caller to notice.
    this.setValue(value)
    this.close()
    this.options.onPick(value)
  }
}

/**
 * Clean up a path somebody typed.
 *
 * `normalizePath` is applied here rather than in `migrateSettings` on purpose:
 * `settings.ts` imports nothing at all from `obsidian`, which is what lets
 * `settings.test.mjs` run it under plain Node, and a runtime import there would
 * break that. Values arriving from a picker are already normalised; typed ones
 * are normalised at the point they are typed, where the Obsidian import is free.
 *
 * The surrounding slashes are stripped on both sides of the call because
 * `normalizePath('')` answers "/", which as a folder rule would mean the whole
 * vault.
 */
export function normalizeTypedPath(value: string): string {
  const trimmed = normalizeFolderRule(value)
  if (!trimmed) return ''
  return normalizeFolderRule(normalizePath(trimmed))
}
