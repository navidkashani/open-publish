/**
 * The publish window.
 *
 * Deliberately thin. It opens, decides which of three screens to show, and gets
 * out of the way:
 *
 *   scanning -> ReviewView -> ProgressView
 *
 * The reason it holds almost nothing is a hazard rather than a preference.
 * Obsidian's `Modal` assigns undocumented instance fields of its own (the one
 * that bit here was `selection`), and any of them silently shadows a subclass
 * member of the same name. TypeScript cannot see it, because the fields are not
 * in the public typings, so the failure arrives at runtime as
 * "this.selection is not a function". Every name below therefore has to be
 * chosen with that in mind, and the fewer of them there are the better.
 *
 * The other thing this window is careful about: it does not own the run.
 * Publishing hands off to a session on the plugin, so closing the window
 * cancels nothing, and reopening it attaches to the run in progress instead of
 * starting a fresh scan.
 */

import { Modal, Notice, Setting, setIcon } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import type { PublishSelection } from '../core/publisher.ts'
import type { PublishSession, PublishSummary } from '../core/session.ts'
import type { ScanResult } from '../core/scanner.ts'
import { PublishError } from '../core/errors.ts'
import { sameContent } from '../core/snapshot.ts'
import { FolderModal } from './FolderModal.ts'
import { folderRulesSummary, summarizeRules } from './FolderRules.ts'
import { ProgressView } from './ProgressView.ts'
import { ReviewView } from './ReviewView.ts'
import { ruleTargetExists } from './RuleList.ts'
import { renderLinkedNotes, renderScanNotices } from './ScanNotices.ts'
import { publishMessage, stateForSession, upToDateStats } from './messages.ts'
import type { ActionId, MessageAction, PublishMessage } from './messages.ts'

export class PublishModal extends Modal {
  private readonly plugin: OpenPublishPlugin
  private scanAbort: AbortController | null = null
  private unsubscribeFromRun: (() => void) | null = null

  constructor(app: App, plugin: OpenPublishPlugin) {
    super(app)
    this.plugin = plugin
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    // Set once, and outside `contentEl`: the title belongs to the modal's own
    // title band, so it stays put while a long review scrolls under it.
    this.setTitle('Publish')
    this.plugin.setPublishWindowOpen(true)
    const session = this.plugin.activeSession()
    // Reopening mid-run shows the run, not a rescan of a vault that is already
    // being published.
    if (session?.isRunning()) this.showProgress(session)
    else void this.startScan()
  }

  override onClose(): void {
    this.plugin.setPublishWindowOpen(false)
    // The scan belongs to this window, so it stops with it. The publish does
    // not: that is the whole point of the session living on the plugin.
    this.scanAbort?.abort()
    this.unsubscribeFromRun?.()
    this.unsubscribeFromRun = null
    this.contentEl.empty()
  }

  /**
   * A clean sheet for the next screen.
   *
   * The title is not re-created here. It is set once in `onOpen` and lives
   * outside `contentEl`, which is what makes "it never jumps" true rather than
   * re-achieved on every redraw.
   */
  private frame(): HTMLElement {
    const { contentEl } = this
    contentEl.empty()
    return contentEl
  }

  private async startScan(): Promise<void> {
    const container = this.frame()
    const status = container.createDiv({ cls: 'op-scan-status', text: 'Looking at your notes…' })

    this.scanAbort?.abort()
    const abort = (this.scanAbort = new AbortController())
    try {
      const scan = await this.plugin.scan({
        signal: abort.signal,
        onProgress: (message, current, total) => {
          status.setText(total ? `${message} ${current} of ${total}` : message)
        },
      })
      if (abort.signal.aborted) return
      this.showReview(scan)
    } catch (error) {
      if (error instanceof PublishError && error.code === 'aborted') return
      this.showFailure(error)
    }
  }

  private showReview(scan: ScanResult): void {
    const container = this.frame()

    // Nothing to decide, so do not make anyone click to find that out.
    const nothingSelected = !scan.previous && Object.keys(scan.snapshot.files).length === 0
    if (nothingSelected) {
      // Storage is already configured by the time this window opens (`main.ts`
      // sends an unconfigured vault to the setup guide), so folders really are
      // the missing step, and the button says so.
      this.showEmptyState(container, publishMessage({ kind: 'nothing-to-publish', reason: 'nothing-selected' }), {
        icon: 'cloud-off',
        scan,
        chooseFolders: true,
      })
      return
    }
    if (sameContent(scan.snapshot, scan.previous)) {
      this.showEmptyState(container, this.upToDateMessage(scan), { icon: 'check', scan, chooseFolders: false })
      return
    }

    const view = new ReviewView(container.createDiv(), scan, {
      onPublish: (selection, summary) => this.beginPublish(scan, selection, summary),
      onRescan: () => void this.startScan(),
      onAddLinked: (paths) => void this.addLinked(paths),
      onCancel: () => this.close(),
    })
    view.render()
  }

  private beginPublish(scan: ScanResult, selection: PublishSelection, summary: PublishSummary): void {
    // A button that does nothing is the worst possible failure: there is no
    // message to report and no way to tell a dead click from a slow one. If
    // starting the run goes wrong, say so on screen.
    try {
      this.showProgress(this.plugin.startPublish(scan, selection, summary))
    } catch (error) {
      this.showFailure(error)
    }
  }

  private showProgress(session: PublishSession): void {
    this.unsubscribeFromRun?.()
    const container = this.frame()
    const view = new ProgressView(container.createDiv(), (id) => this.handleAction(id, session))
    view.render()
    this.unsubscribeFromRun = session.subscribe((status) =>
      view.update(status, stateForSession(status, session.summary)),
    )
  }

  private showFailure(error: unknown): void {
    const publishError = error instanceof PublishError ? error : new PublishError('storage-failed', String(error))
    const message = publishMessage({
      kind: 'failed',
      code: publishError.code,
      message: publishError.message,
      hint: publishError.hint,
    })
    this.showMessage(this.frame(), message, null)
  }

  /**
   * A result that is a *problem*, in a box.
   *
   * The alert chrome is kept for failures, where it is correct, and deliberately
   * not used for the empty states. See `showEmptyState`.
   */
  private showMessage(container: HTMLElement, message: PublishMessage, session: PublishSession | null): void {
    const box = container.createDiv({ cls: `op-result op-notice-${message.tone}` })
    box.createEl('p', { cls: 'op-result-headline', text: message.headline })
    if (message.stats) box.createEl('p', { cls: 'op-result-stats', text: message.stats })
    if (message.body) {
      for (const paragraph of message.body.split('\n')) box.createEl('p', { text: paragraph })
    }

    this.renderActions(container, message.buttons, session)
  }

  /**
   * Nothing to publish, which is not a failure and should not look like one.
   *
   * No card, no tinted background, no accent rule: emptiness reads as text in
   * flow, the way `.op-scan-status` and `.op-rule-empty` already do elsewhere in
   * this plugin. A healthy vault sees the headline, the counts and the footer,
   * and nothing else at all.
   *
   * Everything below the headline is conditional, because this screen used to
   * throw away three things the scan had already computed (warnings, blockers
   * and linked-but-unpublished notes), which made "Add linked" unreachable in
   * precisely the state a site with broken links sits in.
   */
  private showEmptyState(
    container: HTMLElement,
    message: PublishMessage,
    options: { icon: string; scan: ScanResult; chooseFolders: boolean },
  ): void {
    const empty = container.createDiv({ cls: 'op-empty' })
    const headline = empty.createDiv({ cls: 'op-empty-headline' })
    setIcon(headline.createSpan({ cls: 'op-empty-icon' }), options.icon)
    headline.createSpan({ text: message.headline })
    if (message.stats) empty.createDiv({ cls: 'op-empty-stats', text: message.stats })
    if (message.body) {
      for (const paragraph of message.body.split('\n')) empty.createDiv({ cls: 'op-empty-stats', text: paragraph })
    }

    renderScanNotices(container, options.scan)

    // The offers earn their rule only when there is something in them. A rule
    // above an empty group is the pile this screen exists to stop being.
    const linked = options.scan.linkedButUnpublished
    if (options.chooseFolders || linked.length > 0) {
      const offers = container.createDiv({ cls: 'op-offers' })
      renderLinkedNotes(offers, linked, (paths) => void this.addLinked(paths))
      this.renderFoldersOffer(offers, options.chooseFolders)
    }

    this.renderActions(container, message.buttons, null)
  }

  /**
   * The same row the settings tab renders, deliberately.
   *
   * "I expected a note to publish and it didn't" is one of the three reasons
   * anyone is on this screen, and the answer is the folder rules. Reusing the
   * row rather than inventing a link means it *answers* with counts instead of
   * merely pointing somewhere, and it teaches where this lives for next time.
   */
  private renderFoldersOffer(container: HTMLElement, choose: boolean): void {
    const selection = this.plugin.settings.selection
    const summary = summarizeRules({
      files: this.app.vault.getFiles().map((file) => file.path),
      includes: selection.includes,
      excludes: selection.excludes,
      folderExists: (path) => ruleTargetExists(this.app, path),
    })

    new Setting(container)
      .setClass('op-offer')
      .setName('Folders')
      .setDesc(folderRulesSummary(summary))
      .addButton((button) => {
        button.setButtonText(choose ? 'Choose folders…' : 'Manage folders…')
        if (choose) button.setCta()
        button.onClick(() => this.handleAction('manage-folders', null))
      })
  }

  private upToDateMessage(scan: ScanResult): PublishMessage {
    const builder = this.plugin.settings.builder
    // The snapshot's own time, not `lastPublishedAt`: that one is per-device and
    // reads "never" on the machine that did not do the publishing.
    const publishedAt = scan.previous?.createdAt
    return publishMessage({
      kind: 'up-to-date',
      stats: upToDateStats(Object.keys(scan.snapshot.files), publishedAt ? formatWhen(publishedAt) : undefined),
      canVisit: !!builder.siteUrl,
      canRebuild: !!builder.url,
    })
  }

  /** Window-level actions: the things that act on the site, not on a row. */
  private renderActions(container: HTMLElement, buttons: MessageAction[], session: PublishSession | null): void {
    const actions = container.createDiv({ cls: 'op-progress-actions' })
    for (const button of buttons) {
      if (button.id === 'cancel') continue
      const el = actions.createEl('button', { text: button.label })
      if (button.primary) el.addClass('mod-cta')
      el.addEventListener('click', () => this.handleAction(button.id, session))
    }
  }

  private async addLinked(paths: string[]): Promise<void> {
    for (const path of paths) this.plugin.settings.selection.explicit[path] = true
    await this.plugin.saveSettings()
    new Notice(paths.length === 1 ? 'Added 1 linked note.' : `Added ${paths.length} linked notes.`)
    void this.startScan()
  }

  private handleAction(id: ActionId, session: PublishSession | null): void {
    switch (id) {
      case 'cancel':
        session?.cancel()
        return
      case 'done':
      case 'close':
        this.close()
        return
      case 'visit-site':
        this.openUrl(this.plugin.settings.builder.siteUrl)
        return
      case 'open-logs':
        this.openUrl(this.plugin.settings.builder.logsUrl)
        return
      case 'open-settings':
        this.close()
        this.plugin.openSettings()
        return
      case 'finish-setup':
        this.close()
        this.plugin.openSetup()
        return
      case 'manage-folders':
        // Deliberately does not close this window, unlike `open-settings`: the
        // dialog is a detour, and the rescan on the way back is the whole
        // point. A rule change that left a stale "up to date" screen behind
        // would be worse than not offering the link at all.
        new FolderModal(this.app, this.plugin, () => void this.startScan()).open()
        return
      case 'update-now':
        void this.plugin.triggerBuildOnly()
        return
      case 'try-again':
      case 'rescan':
        void this.startScan()
        return
    }
  }

  private openUrl(url: string): void {
    if (!url) {
      new Notice('No address is set for that yet. Add one in Open Publish settings.')
      return
    }
    // Deliberately not checked for a null return: Electron hands back null on a
    // *successful* hand-off to the system browser, so treating that as failure
    // would cry wolf on every desktop. A throw is unambiguous, and the address
    // is worth more to someone stranded than a dead button is.
    try {
      window.open(url, '_blank')
    } catch {
      new Notice(`Could not open that. The address is:\n${url}`, 12000)
    }
  }
}

/**
 * The one place a timestamp becomes words.
 *
 * `messages.ts` stays free of it so its tests do not depend on the machine's
 * locale. A snapshot parsed from an older format can carry `createdAt: 0`,
 * which is not a time anyone published anything.
 */
function formatWhen(createdAt: number): string | undefined {
  if (!createdAt) return undefined
  return new Date(createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
