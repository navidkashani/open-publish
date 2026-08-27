/**
 * Site history: the two screens between "I published something I should not
 * have" and the pointer moving.
 *
 * The list, then a confirm. Both matter, and the confirm matters more, because
 * the dominant reason to open this window is a mistake somebody wants undone
 * and the word "roll back" invites a reading the feature cannot honour:
 *
 *  - it removes the note **from the site**, after the next build;
 *  - the object **stays in the bucket**, content-addressed, still referenced by
 *    the newer snapshot and inside clean-up's grace period.
 *
 * The bucket is private and the build reads it with a separate read-only key
 * (docs/security.md), so this is smaller than it sounds. It is said anyway,
 * because the alternative is letting somebody infer otherwise about the one
 * thing they came here to be sure of.
 *
 * The window is called Site history, and the button says "Make this live",
 * because the list is whatever manifests are in the bucket and that includes
 * ones *newer* than the live pointer. Rolling forward is the same single write,
 * so nothing here may claim the only direction is backwards.
 */

import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import type { RollbackResult } from '../main.ts'
import { toPublishError } from '../core/errors.ts'
import { missingObjectsMessage } from '../core/rollback.ts'
import type { RollbackPlan, SiteVersion, SiteVersionList } from '../core/rollback.ts'
import { renderPickerList } from './PickerList.ts'
import type { PickerRow } from './PickerList.ts'

export class RollbackModal extends Modal {
  private readonly plugin: OpenPublishPlugin
  /** Lets the settings tab repaint the panel this window can raise or clear. */
  private readonly onDone: () => void
  /** Cancels whatever listing or planning is in flight when the window closes. */
  private controller: AbortController | null = null

  // Written out rather than as constructor parameter properties: Node's
  // type-stripping cannot erase those, and the test suite runs this file.
  constructor(app: App, plugin: OpenPublishPlugin, onDone: () => void = () => {}) {
    super(app)
    this.plugin = plugin
    this.onDone = onDone
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.setTitle('Site history')
    void this.showList()
  }

  override onClose(): void {
    this.controller?.abort()
    this.controller = null
    this.contentEl.empty()
    this.onDone()
  }

  /** A fresh signal per screen: closing mid-listing must not cancel nothing. */
  private restart(): AbortSignal {
    this.controller?.abort()
    this.controller = new AbortController()
    return this.controller.signal
  }

  // --- screen one: the list -------------------------------------------------

  private async showList(): Promise<void> {
    const signal = this.restart()
    const status = this.working('Reading your site history…')

    let list: SiteVersionList
    try {
      list = await this.plugin.listSiteVersions({
        signal,
        onProgress: (message) => status.setText(message),
      })
    } catch (error) {
      if (signal.aborted) return
      this.showError(error, 'Your site history could not be read.')
      return
    }
    if (signal.aborted) return
    this.renderList(list)
  }

  private renderList(list: SiteVersionList): void {
    const { contentEl } = this
    contentEl.empty()

    if (list.versions.length === 0) {
      contentEl.createEl('p', {
        cls: 'op-rule-intro',
        text: 'There are no published versions in your storage yet. Publish once and this fills up.',
      })
      this.closeRow()
      return
    }

    contentEl.createEl('p', {
      cls: 'op-rule-intro',
      text:
        'Every version of your site still in storage. Making one live changes what visitors see once the ' +
        'site rebuilds; it does not change a single note in your vault.',
    })

    renderPickerList(contentEl, list.versions.map(versionRow), '', (id) => {
      const version = list.versions.find((candidate) => candidate.id === id)
      if (!version?.restorable || version.live) return
      void this.showConfirm(version)
    })

    if (list.truncated > 0) {
      contentEl.createDiv({
        cls: 'setting-item-description op-version-truncated',
        text: `${list.truncated} older version(s) are in storage but not listed here.`,
      })
    }

    this.closeRow()
  }

  // --- screen two: the confirm ---------------------------------------------

  private async showConfirm(version: SiteVersion): Promise<void> {
    const signal = this.restart()
    const status = this.working(`Checking what ${formatVersion(version)} would change…`)

    let plan: RollbackPlan
    try {
      plan = await this.plugin.planRollback(version.id, {
        signal,
        onProgress: (message) => status.setText(message),
      })
    } catch (error) {
      if (signal.aborted) return
      this.showError(error, 'That version could not be checked.')
      return
    }
    if (signal.aborted) return
    // The row was disabled on the *list's* verdict; the plan recounts against a
    // fresh listing. When a clean-up has run in between, the two disagree, and
    // drawing an enabled button that is guaranteed to be refused would be
    // telling somebody the choice is theirs when it is not.
    if (plan.missingObjects > 0) {
      this.showUnavailable(version, plan.missingObjects)
      return
    }
    this.renderConfirm(version, plan)
  }

  private showUnavailable(version: SiteVersion, missing: number): void {
    const { contentEl } = this
    contentEl.empty()
    const box = contentEl.createDiv({ cls: 'op-notice-warning' })
    box.createEl('p', { text: `The ${formatVersion(version)} version cannot be made live.` })
    box.createEl('p', { text: missingObjectsMessage(missing, version.id) })
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Back')
        .setCta()
        .onClick(() => void this.showList()),
    )
  }

  private renderConfirm(version: SiteVersion, plan: RollbackPlan): void {
    const { contentEl } = this
    contentEl.empty()

    contentEl.createEl('p', {
      cls: 'op-rule-intro',
      text: `Making the ${formatVersion(version)} version live.`,
    })

    // What the site gains and loses, in that order, because "what comes off"
    // is the sentence somebody undoing a mistake is here to read.
    const counts = contentEl.createDiv({ cls: 'op-version-diff' })
    for (const line of describeDiff(plan)) counts.createEl('p', { text: line })

    if (plan.optionChanges.length > 0) {
      contentEl.createEl('p', { cls: 'op-version-options-title', text: 'Your site options go back too:' })
      const options = contentEl.createDiv({ cls: 'op-version-options' })
      for (const change of plan.optionChanges) {
        options.createDiv({
          cls: change.warn ? 'op-version-option op-version-option-warn' : 'op-version-option',
          text: `${change.option}: ${change.before} → ${change.after}`,
        })
      }
    }

    // The two sentences this window exists to say. Both are here rather than in
    // a tooltip because both correct a reading somebody would otherwise leave
    // with, and one of them is about what stays behind.
    const honesty = contentEl.createDiv({ cls: 'op-notice-info op-version-honesty' })
    honesty.createEl('p', { text: 'Nothing changes until the site rebuilds.' })
    honesty.createEl('p', {
      text:
        'Pages this takes off the site stay in your storage. They are no longer published, and no longer ' +
        'reachable from your site, but this does not delete them.',
    })

    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Back').onClick(() => void this.showList()))
      .addButton((button) =>
        button
          .setButtonText('Make this live')
          .setWarning()
          .onClick(() => {
            button.setButtonText('Making it live…').setDisabled(true)
            void this.commit(plan)
          }),
      )
  }

  // --- committing -----------------------------------------------------------

  private async commit(plan: RollbackPlan): Promise<void> {
    // Deliberately not cancellable, and deliberately not tied to the window:
    // this is one small write, and a closed window must not abort it half way.
    this.controller?.abort()
    this.controller = null
    const status = this.working('Making that version live…')

    let result: RollbackResult
    try {
      result = await this.plugin.rollBackTo(plan)
    } catch (error) {
      status.setText('')
      this.showError(error, 'That version could not be made live.')
      return
    }

    // Reported as a Notice rather than a third screen, the same way clean-up
    // and the self-test report: the durable half of this now lives in the
    // settings panel and the publish review, where it will still be when it
    // matters.
    new Notice(describeResult(result), result.build === 'started' ? 8000 : 12000)
    this.close()
  }

  // --- shared furniture -----------------------------------------------------

  /** Replaces the window with one line, and hands it back so progress can update it. */
  private working(message: string): HTMLElement {
    const { contentEl } = this
    contentEl.empty()
    return contentEl.createEl('p', { cls: 'op-rule-intro', text: message })
  }

  private showError(error: unknown, fallback: string): void {
    const { contentEl } = this
    contentEl.empty()
    const box = contentEl.createDiv({ cls: 'op-notice-error' })
    box.createEl('p', { text: toPublishError(error, fallback).toDisplayString() })
    new Setting(contentEl)
      .addButton((button) => button.setButtonText('Back').onClick(() => void this.showList()))
      .addButton((button) =>
        button
          .setButtonText('Close')
          .setCta()
          .onClick(() => this.close()),
      )
  }

  private closeRow(): void {
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText('Close')
        .setCta()
        .onClick(() => this.close()),
    )
  }
}

// --- copy -------------------------------------------------------------------

function versionRow(version: SiteVersion): PickerRow {
  return {
    id: version.id,
    name: formatVersion(version),
    badge: version.live ? 'Live' : undefined,
    summary: version.live
      ? `${countFiles(version.fileCount)}. This is what your site is showing now.`
      : countFiles(version.fileCount),
    caution: version.unavailable,
    // The live one is not a target either: making it live again does nothing,
    // and offering it would spend a build to say so.
    disabled: !version.restorable || version.live,
  }
}

function formatVersion(version: SiteVersion): string {
  return version.createdAt ? new Date(version.createdAt).toLocaleString() : version.id
}

function countFiles(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

/**
 * The diff in sentences, and never a bare "12 changed".
 *
 * `added`/`removed` are relative to what the site is showing now, so going back
 * *adds* what the older version had and *removes* what has been published
 * since. Naming them the other way round is the single easiest way to make
 * somebody undo the wrong thing.
 */
function describeDiff(plan: RollbackPlan): string[] {
  const { added, changed, removed } = plan.diff
  const lines: string[] = []
  if (removed.length > 0) {
    lines.push(
      removed.length === 1
        ? `1 page comes off the site: ${removed[0]}`
        : `${removed.length} pages come off the site, including ${removed[0]}`,
    )
  }
  if (added.length > 0) {
    lines.push(added.length === 1 ? `1 page comes back: ${added[0]}` : `${added.length} pages come back.`)
  }
  if (changed.length > 0) {
    lines.push(
      changed.length === 1
        ? `1 page goes back to its earlier version: ${changed[0]}`
        : `${changed.length} pages go back to their earlier versions.`,
    )
  }
  if (lines.length === 0) lines.push('No pages change. Only your site options differ between these versions.')
  return lines
}

/**
 * Two facts, never one verdict.
 *
 * The pointer moved or this function was never reached, so a build that did not
 * start is reported as a build that did not start. "Rollback failed" would be
 * false in every branch here.
 */
function describeResult(result: RollbackResult): string {
  const done = 'That version is live.'
  if (result.build === 'started') return `${done} Your site is rebuilding now.`
  if (result.build === 'not-configured') {
    return `${done} There is no deploy hook set up, so your site will not change until it is built again.`
  }
  return `${done} The build could not be started: ${result.buildError ?? 'unknown error'}`
}
