/**
 * The publish window.
 *
 * Deliberately thin. It opens, decides which of three screens to show, and gets
 * out of the way:
 *
 *   scanning -> ReviewView -> ProgressView
 *
 * The reason it holds almost nothing is a hazard rather than a preference.
 * Obsidian's `Modal` assigns undocumented instance fields of its own — the one
 * that bit here was `selection` — and any of them silently shadows a subclass
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

import { Modal, Notice } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import type { PublishSelection } from '../core/publisher.ts'
import type { PublishSession, PublishSummary } from '../core/session.ts'
import type { ScanResult } from '../core/scanner.ts'
import { PublishError } from '../core/errors.ts'
import { sameContent } from '../core/snapshot.ts'
import { ProgressView } from './ProgressView.ts'
import { ReviewView } from './ReviewView.ts'
import { publishMessage, stateForSession } from './messages.ts'
import type { ActionId, PublishMessage } from './messages.ts'

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
    // not — that is the whole point of the session living on the plugin.
    this.scanAbort?.abort()
    this.unsubscribeFromRun?.()
    this.unsubscribeFromRun = null
    this.contentEl.empty()
  }

  /** Every screen starts with the same title, so it never jumps. */
  private frame(): HTMLElement {
    const { contentEl } = this
    contentEl.empty()
    contentEl.createEl('h2', { text: 'Publish' })
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
    if (nothingSelected || sameContent(scan.snapshot, scan.previous)) {
      this.showMessage(
        container,
        publishMessage(
          nothingSelected ? { kind: 'nothing-to-publish', reason: 'nothing-selected' } : { kind: 'nothing-to-publish' },
        ),
        null,
      )
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

  private showMessage(container: HTMLElement, message: PublishMessage, session: PublishSession | null): void {
    const box = container.createDiv({ cls: `op-result op-notice-${message.tone}` })
    box.createEl('p', { cls: 'op-result-headline', text: message.headline })
    if (message.stats) box.createEl('p', { cls: 'op-result-stats', text: message.stats })
    if (message.body) {
      for (const paragraph of message.body.split('\n')) box.createEl('p', { text: paragraph })
    }

    const actions = container.createDiv({ cls: 'op-progress-actions' })
    for (const button of message.buttons) {
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
    if (url) window.open(url, '_blank')
    else new Notice('No address is set for that yet — add one in Open Publish settings.')
  }
}
