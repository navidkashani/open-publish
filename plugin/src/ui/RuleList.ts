/**
 * A list of rules, and the one control that removes one.
 *
 * Shared by both folder lists in the manage-folders dialog, by the wizard's
 * "choose what to publish" step, and by the per-file overrides list in
 * settings, because they are all the same object: a path, what it is currently
 * doing, and a way to take it back.
 *
 * The remove control is a real focusable button rather than a styled span, so
 * Tab reaches it and Enter presses it. It is hidden until hover on desktop,
 * matching Obsidian Publish; the touch story is in the CSS and in the long-press
 * menu below.
 */

import { Menu, Platform, Setting, setIcon } from 'obsidian'
import type { App } from 'obsidian'
import { isAlwaysExcluded } from '../core/selection.ts'
import { DEAD_RULE_WARNING, noteCountLabel } from './FolderRules.ts'
import type { RuleStat } from './FolderRules.ts'
import { PathSuggest, normalizeTypedPath } from './PathSuggest.ts'
import { attachLongPress } from './longpress.ts'

/** Cleans up anything that outlives a re-render. Call it before rebuilding. */
export type Disposer = () => void

export interface RuleRow {
  path: string
  /** A Lucide icon name: a folder rule and a per-file choice should not look alike. */
  icon: string
  /** The right-hand status: "12 notes", "published", "excluded". */
  meta: string
  /** Shown under the path, in the warning colour. */
  warning?: string | null
  /**
   * Optional, and its absence is the whole of "read-only".
   *
   * The Obsidian Publish import preview lists rules nobody can edit there, on
   * purpose: it is a preview of a decision, and a second rule editor beside the
   * one in Manage folders would only drift from it. Without a handler there is
   * no remove button and no long-press menu, so there is nothing to press.
   */
  onRemove?: () => void
}

export function renderRuleRows(container: HTMLElement, rows: RuleRow[], emptyText: string): Disposer {
  if (rows.length === 0) {
    container.createDiv({ cls: 'op-muted op-rule-empty', text: emptyText })
    return () => {}
  }

  const disposers: Disposer[] = []
  for (const row of rows) {
    const setting = new Setting(container).setClass('op-rule-row')

    setIcon(setting.nameEl.createSpan({ cls: 'op-rule-icon' }), row.icon)
    setting.nameEl.createSpan({ cls: 'op-rule-path', text: row.path })

    if (row.warning) {
      setting.settingEl.addClass('op-rule-dead')
      setIcon(setting.descEl.createSpan({ cls: 'op-rule-warning-icon' }), 'alert-triangle')
      setting.descEl.createSpan({ text: row.warning })
    }

    setting.controlEl.createSpan({ cls: 'op-rule-meta', text: row.meta })

    const onRemove = row.onRemove
    if (onRemove) {
      setting.addExtraButton((button) => {
        button.extraSettingsEl.addClass('op-rule-remove')
        button.setIcon('x').setTooltip(`Remove ${row.path}`).onClick(onRemove)
      })

      // There is no hover on a phone, so the gesture is the other way in. It opens
      // a menu rather than removing outright: a hold that silently deletes a rule
      // is a worse surprise than one extra tap.
      if (Platform.isMobile) disposers.push(attachRemoveMenu(setting.settingEl, onRemove))
    }
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

function attachRemoveMenu(el: HTMLElement, onRemove: () => void): Disposer {
  return attachLongPress(el, {
    onLongPress: (point) => {
      const menu = new Menu()
      menu.addItem((item) => item.setTitle('Remove').setIcon('x').onClick(onRemove))
      menu.showAtPosition({ x: point.x, y: point.y })
    },
  })
}

// --- folder lists ----------------------------------------------------------

export interface FolderListOptions {
  app: App
  container: HTMLElement
  /** Counts and dead-rule state, already computed by `summarizeRules`. */
  stats: RuleStat[]
  /**
   * Every folder already spoken for, across *both* lists. Read at suggestion
   * time rather than captured, so a folder added a moment ago stops being
   * offered without rebuilding the suggester.
   */
  taken: () => string[]
  placeholder: string
  emptyText: string
  onAdd: (rule: string) => void
  onRemove: (rule: string) => void
}

/**
 * One list plus its picker. The picker offers real folders; typing one that
 * does not exist is still allowed, and produces a row that says so.
 */
export function renderFolderList(options: FolderListOptions): Disposer {
  const { app, container, stats } = options

  const dispose = renderRuleRows(
    container,
    stats.map((stat) => ({
      path: stat.rule,
      icon: 'folder',
      meta: noteCountLabel(stat.count),
      warning: stat.exists ? null : DEAD_RULE_WARNING,
      onRemove: () => options.onRemove(stat.rule),
    })),
    options.emptyText,
  )

  new Setting(container).setClass('op-rule-add').addSearch((search) => {
    search.setPlaceholder(options.placeholder)

    const add = (raw: string): void => {
      const rule = normalizeTypedPath(raw)
      search.setValue('')
      if (rule) options.onAdd(rule)
    }

    new PathSuggest(app, search.inputEl, {
      items: () => {
        const taken = new Set(options.taken())
        return folderChoices(app).filter((path) => !taken.has(path))
      },
      onPick: add,
    })

    // The suggester swallows Enter while its popover is open, so this only fires
    // for a path with no suggestions behind it, which is exactly the
    // not-created-yet case that has to stay typeable.
    search.inputEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      add(search.getValue())
    })
  })

  return dispose
}

/**
 * Folders worth offering: everything but the dot-folders that are excluded
 * unconditionally, and the vault root.
 *
 * The root is left out deliberately. `getAllFolders(true)` reports it as "/",
 * which normalises to the empty string, and an empty rule means "the whole
 * vault" (`matchesFolderRule`). Offering it would turn publishing an entire
 * vault, credentials folder aside, into a one-click accident.
 */
function folderChoices(app: App): string[] {
  return app.vault
    .getAllFolders(false)
    .map((folder) => folder.path)
    .filter((path) => path !== '' && path !== '/' && !isAlwaysExcluded(path))
    .sort((a, b) => a.localeCompare(b))
}
