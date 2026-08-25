/**
 * The review screen: what is about to change, and what the ticks mean.
 *
 * Deliberately *not* a `Modal` subclass, and that is the point. Obsidian's
 * `Modal` sets undocumented instance fields — `selection` among them — which
 * silently shadow any method of the same name on a subclass, with no type error
 * to warn you. Keeping the state and the logic in a plain class the window owns
 * removes the whole collision surface: the only names that have to be safe are
 * the handful left on the window itself.
 *
 * The tick rules it implements:
 *
 *   new + ticked                 -> published
 *   new + unticked               -> left alone
 *   changed + ticked             -> updated
 *   changed + unticked           -> the published version stays live
 *   already published, untouched -> stays live
 *   already published + ticked   -> taken off the site
 */

import { Setting, setIcon } from 'obsidian'
import type { ScanResult } from '../core/scanner.ts'
import type { PublishSelection } from '../core/publisher.ts'
import type { PublishSummary } from '../core/session.ts'
import { formatBytes } from '../core/limits.ts'
import { snapshotContentKey } from '../core/snapshot.ts'
import { buildTree, countSelected } from './FileTree.ts'
import { TreeView } from './TreeView.ts'
import { RemovalGuard, publishButtonLabel, removalConfirmLabel, reviewSummary } from './messages.ts'

export interface ReviewActions {
  onPublish: (selection: PublishSelection, summary: PublishSummary) => void
  onRescan: () => void
  onAddLinked: (paths: string[]) => void
  onCancel: () => void
}

/** The scan, sorted into the sections the screen shows. */
interface Sections {
  changed: string[]
  added: string[]
  /** Already on the site and unchanged. Ticking one takes it off. */
  published: string[]
  removed: string[]
  renames: Array<{ from: string; to: string }>
  /** Renamed files are applied whatever happens, so they are never tickable. */
  renameTargets: Set<string>
}

export class ReviewView {
  private readonly container: HTMLElement
  private readonly scan: ScanResult
  private readonly actions: ReviewActions
  private readonly sections: Sections

  /** Ticked in New and Changed: publish this version. Starts full. */
  private readonly include = new Set<string>()
  /** Ticked in Already published: take this page off the site. Starts empty. */
  private readonly unpublish = new Set<string>()
  private readonly removalGuard = new RemovalGuard()

  private publishButton: HTMLButtonElement | null = null
  private summaryEl: HTMLElement | null = null
  private uploadSizeEl: HTMLElement | null = null

  constructor(container: HTMLElement, scan: ScanResult, actions: ReviewActions) {
    this.container = container
    this.scan = scan
    this.actions = actions
    this.sections = sortIntoSections(scan)
    for (const path of this.sections.added) this.include.add(path)
    for (const path of this.sections.changed) this.include.add(path)
  }

  render(): void {
    const scan = this.scan
    const sections = this.sections
    const contentEl = this.container
    contentEl.empty()

    if (scan.blockers.length > 0) {
      const box = contentEl.createDiv({ cls: 'op-notice-error op-blockers' })
      box.createEl('p', {
        text:
          scan.blockers.length === 1
            ? 'One problem has to be fixed first:'
            : `${scan.blockers.length} problems have to be fixed first:`,
      })
      for (const item of scan.blockers) {
        const row = box.createEl('div', { cls: 'op-blocker' })
        row.createEl('div', { text: item.message })
        if (item.paths.length > 0) row.createEl('div', { cls: 'op-muted', text: item.paths.join(', ') })
      }
    }

    for (const warning of scan.warnings) {
      contentEl.createDiv({ cls: 'op-notice-warning', text: warning })
    }

    const summary = contentEl.createDiv({ cls: 'op-summary' })
    this.summaryEl = summary.createSpan()
    this.uploadSizeEl = summary.createSpan({ cls: 'op-muted' })

    const list = contentEl.createDiv({ cls: 'op-file-list' })
    this.renderSection(list, { title: 'Changed', paths: sections.changed, selected: this.include, open: true })
    this.renderSection(list, {
      title: 'New',
      paths: sections.added,
      selected: this.include,
      open: true,
      badge: (path) => (scan.autoIncluded.has(path) ? 'linked' : null),
    })
    this.renderRenames(list, sections)
    this.renderSection(list, {
      title: 'Removed',
      paths: sections.removed,
      selected: null,
      open: false,
      hint: 'No longer in your published set — deleted, excluded, or marked publish: false.',
    })
    this.renderSection(list, {
      title: 'Already published — select to unpublish',
      paths: sections.published,
      selected: this.unpublish,
      open: false,
      hint: 'These stay on your site. Tick one to take it off.',
    })

    this.renderFooter(contentEl, scan)
    this.refreshTotals()
  }

  /**
   * One collapsible section.
   *
   * Collapsing is done by hand rather than with `<details>`: a `<summary>`
   * treats clicks on the buttons inside it inconsistently across browsers, and
   * "All" folding the section you are working in is a maddening way to find
   * that out.
   */
  private renderSection(
    container: HTMLElement,
    options: {
      title: string
      paths: string[]
      /** Null for an information-only section: no ticks, nothing to choose. */
      selected: Set<string> | null
      open: boolean
      hint?: string
      badge?: (path: string) => string | null
    },
  ): void {
    if (options.paths.length === 0) return

    const section = container.createDiv({ cls: 'op-section' })
    const header = section.createDiv({ cls: 'op-section-header' })
    const twisty = header.createSpan({ cls: 'op-twisty' })
    setIcon(twisty, 'chevron-down')
    header.createSpan({ cls: 'op-section-title', text: options.title })
    const counter = header.createSpan({ cls: 'op-section-count' })

    const body = section.createDiv({ cls: 'op-section-body' })
    if (options.hint) body.createDiv({ cls: 'op-muted op-section-hint', text: options.hint })
    const treeEl = body.createDiv()

    const selected = options.selected
    const nodes = buildTree(options.paths)
    const setCount = () => {
      counter.setText(
        selected
          ? `${countSelected(options.paths, selected)} of ${options.paths.length} selected`
          : `${options.paths.length}`,
      )
    }

    const view = new TreeView(treeEl, nodes, {
      selected,
      badge: options.badge,
      onChange: () => {
        this.touched()
        setCount()
        this.refreshTotals()
      },
    })

    // A section can be thousands of rows on a real vault — an "Already
    // published" list, or a removal caused by one mistyped exclude rule — so
    // rows are built when it is first opened, never before.
    let built = false
    const expand = (open: boolean) => {
      // Only the body collapses. Putting the hide-class on the section itself
      // would take its own header with it, leaving nothing to click to get back.
      section.toggleClass('op-section-closed', !open)
      twisty.toggleClass('op-twisty-open', open)
      body.toggleClass('op-collapsed', !open)
      if (!open || built) return
      built = true
      view.render()
    }

    if (selected) {
      for (const [label, wanted] of [
        ['All', true],
        ['None', false],
      ] as const) {
        const button = header.createEl('button', { cls: 'op-section-action', text: label })
        button.addEventListener('click', (event) => {
          event.stopPropagation()
          for (const path of options.paths) {
            if (wanted) selected.add(path)
            else selected.delete(path)
          }
          view.refresh()
          this.touched()
          setCount()
          this.refreshTotals()
        })
      }
    }

    header.addEventListener('click', () => expand(section.hasClass('op-section-closed')))
    setCount()
    expand(options.open)
  }

  private renderRenames(container: HTMLElement, sections: Sections): void {
    if (sections.renames.length === 0) return
    const section = container.createDiv({ cls: 'op-section' })
    const header = section.createDiv({ cls: 'op-section-header' })
    const twisty = header.createSpan({ cls: 'op-twisty op-twisty-open' })
    setIcon(twisty, 'chevron-down')
    header.createSpan({ cls: 'op-section-title', text: 'Renamed' })
    header.createSpan({ cls: 'op-section-count', text: `${sections.renames.length}` })

    const body = section.createDiv({ cls: 'op-section-body' })
    body.createDiv({ cls: 'op-muted op-section-hint', text: 'Old links keep working — they redirect to the new address.' })
    for (const rename of sections.renames) {
      const row = body.createDiv({ cls: 'op-tree-row op-row-file op-rename-row' })
      setIcon(row.createSpan({ cls: 'op-tree-icon' }), 'corner-down-right')
      row.createSpan({ cls: 'op-muted', text: rename.from })
      row.createSpan({ cls: 'op-muted', text: '→' })
      row.createSpan({ cls: 'op-tree-name', text: rename.to })
    }

    header.addEventListener('click', () => {
      const collapsed = !section.hasClass('op-section-closed')
      section.toggleClass('op-section-closed', collapsed)
      body.toggleClass('op-collapsed', collapsed)
      twisty.toggleClass('op-twisty-open', !collapsed)
    })
  }

  /** Any tick withdraws a pending removal confirmation: the numbers just moved. */
  private touched(): void {
    this.removalGuard.reset()
  }

  private counts(): { changes: number; removals: number } {
    const sections = this.sections
    return {
      // Renames are applied whatever the ticks say, which is exactly why they
      // have to be counted here: they are filtered out of New and Removed, so a
      // vault whose only change is a rename would otherwise reach this screen
      // with nothing to publish and a greyed-out button above a Renamed section.
      changes:
        countSelected(sections.added, this.include) +
        countSelected(sections.changed, this.include) +
        sections.renameTargets.size,
      removals: sections.removed.length + this.unpublish.size,
    }
  }

  private uploadBytes(): number {
    const scan = this.scan
    let bytes = 0
    for (const path of this.include) bytes += scan.snapshot.files[path]?.size ?? 0
    return bytes
  }

  private refreshTotals(): void {
    const sections = this.sections
    const { changes, removals } = this.counts()

    this.summaryEl?.setText(
      reviewSummary({
        changed: countSelected(sections.changed, this.include),
        added: countSelected(sections.added, this.include),
        removed: removals,
        renamed: sections.renames.length,
      }),
    )
    this.uploadSizeEl?.setText(`${formatBytes(this.uploadBytes())} to upload`)

    const button = this.publishButton
    const scan = this.scan
    if (!button) return

    button.removeClass('op-confirm')
    if (scan.blockers.length > 0) {
      button.disabled = true
      button.setText('Fix the problems above')
      return
    }
    if (this.removalGuard.isArmed()) {
      button.disabled = false
      button.addClass('op-confirm')
      button.setText(removalConfirmLabel(removals))
      return
    }
    if (changes === 0 && removals === 0) {
      // A site option can change with no file changes at all, and that is still
      // something to publish.
      const siteChanged =
        !!scan.previous && snapshotContentKey({}, scan.snapshot.site) !== snapshotContentKey({}, scan.previous.site)
      button.disabled = !siteChanged
      button.setText(siteChanged ? 'Publish site settings' : 'Publish')
      return
    }
    button.disabled = false
    button.setText(publishButtonLabel({ changes, removals }))
  }

  private renderFooter(container: HTMLElement, scan: ScanResult): void {
    if (scan.linkedButUnpublished.length > 0) {
      new Setting(container)
        .setName('Linked notes that are not published')
        .setDesc(
          `${scan.linkedButUnpublished.length} note(s) are linked from your published notes but are not published themselves. ` +
            'Right now those links render as plain text. Adding them publishes them too.',
        )
        .addButton((button) =>
          button.setButtonText('Add linked').onClick(() => {
            this.actions.onAddLinked(scan.linkedButUnpublished)
          }),
        )
    }

    const actions = container.createDiv({ cls: 'op-progress-actions' })
    const publish = actions.createEl('button', { cls: 'mod-cta' })
    this.publishButton = publish
    publish.addEventListener('click', () => this.requestPublish())

    const rescan = actions.createEl('button', { text: 'Rescan' })
    rescan.addEventListener('click', () => this.actions.onRescan())

    const cancel = actions.createEl('button', { text: 'Cancel' })
    cancel.addEventListener('click', () => this.actions.onCancel())
  }

  /** Turn the two tick sets into the publisher's selection. */
  private chosen(): PublishSelection {
    const sections = this.sections
    const include = new Set<string>()
    const keepPrevious = new Set<string>()

    for (const path of sections.added) {
      if (this.include.has(path)) include.add(path)
    }
    for (const path of sections.changed) {
      if (this.include.has(path)) include.add(path)
      else keepPrevious.add(path)
    }
    for (const path of sections.published) {
      if (!this.unpublish.has(path)) include.add(path)
    }
    for (const path of sections.renameTargets) include.add(path)

    return { include, keepPrevious }
  }

  /** The Publish button. Confirms first when the removal count is a surprise. */
  private requestPublish(): void {
    const scan = this.scan
    const { changes, removals } = this.counts()

    // A mistyped exclude rule can quietly take a hundred pages down. One extra
    // click is a small price for a change that is tedious to undo.
    if (!this.removalGuard.confirm(removals)) {
      this.refreshTotals()
      return
    }

    this.actions.onPublish(this.chosen(), {
      updates: changes,
      removals,
      firstPublish: scan.isFirstPublish,
    })
  }
}

function sortIntoSections(scan: ScanResult): Sections {
  const renameTargets = new Set(scan.renames.map((rename) => rename.to))
  const renameSources = new Set(scan.renames.map((rename) => rename.from))
  return {
    // A rename is not a new page and not a removed one — it is the same page at
    // a new address, and its own section says so. Listing it as both would
    // invite someone to untick "new" and take their own note down.
    added: scan.added.filter((path) => !renameTargets.has(path)),
    changed: scan.changed,
    published: scan.unchanged,
    removed: scan.removed.filter((path) => !renameSources.has(path)),
    renames: scan.renames,
    renameTargets,
  }
}
