/**
 * The publish progress panel.
 *
 * Renders into a container the caller owns, and paints from a `SessionStatus`
 * rather than accumulating events, which is what lets a window reopened
 * halfway through a run show the run's actual state instead of starting over.
 *
 * Two design rules live here:
 *
 *  - Success shows the moment the site update is *requested*, not when it
 *    finishes. A rebuild takes one to three minutes and there is nothing to
 *    decide during it, so making someone watch it is just making them wait.
 *  - Cancel is offered only while there is something to cancel. Once the notes
 *    are stored the button goes away rather than lying about what it does.
 */

import { setIcon } from 'obsidian'
import type { SessionStatus } from '../core/session.ts'
import type { ActionId, PublishMessage, PublishState } from './messages.ts'
import { publishMessage } from './messages.ts'

export class ProgressView {
  private headlineEl!: HTMLElement
  private statsEl!: HTMLElement
  private statusEl!: HTMLElement
  private detailEl!: HTMLElement
  private barEl!: HTMLElement
  private barFillEl!: HTMLElement
  private countEl!: HTMLElement
  private noticeEl!: HTMLElement
  private logEl!: HTMLElement
  private skippedEl: HTMLElement | null = null
  private moreEl: HTMLElement | null = null
  private actionsEl!: HTMLElement
  private renderedUploads = 0

  private readonly container: HTMLElement
  private readonly onAction: (id: ActionId) => void

  constructor(container: HTMLElement, onAction: (id: ActionId) => void) {
    this.container = container
    this.onAction = onAction
  }

  render(): void {
    this.container.empty()
    this.container.addClass('op-progress')
    this.renderedUploads = 0
    this.skippedEl = null
    this.moreEl = null

    this.headlineEl = this.container.createDiv({ cls: 'op-progress-headline' })
    this.statsEl = this.container.createDiv({ cls: 'op-progress-stats' })
    this.statsEl.hide()
    this.noticeEl = this.container.createDiv({ cls: 'op-progress-notice' })
    this.noticeEl.hide()

    this.statusEl = this.container.createDiv({ cls: 'op-progress-status' })
    this.detailEl = this.container.createDiv({ cls: 'op-progress-detail' })
    this.detailEl.hide()

    this.barEl = this.container.createDiv({ cls: 'op-progress-bar' })
    this.barFillEl = this.barEl.createDiv({ cls: 'op-progress-bar-fill' })
    this.barEl.hide()
    this.countEl = this.container.createDiv({ cls: 'op-progress-count' })

    this.logEl = this.container.createDiv({ cls: 'op-progress-log' })
    this.actionsEl = this.container.createDiv({ cls: 'op-progress-actions' })
  }

  update(status: SessionStatus, state: PublishState): void {
    const message = publishMessage(state)
    const running = state.kind === 'publishing'

    this.headlineEl.setText(message.headline)
    this.headlineEl.toggleClass('op-progress-headline-done', !running)

    if (message.stats) {
      this.statsEl.show()
      this.statsEl.setText(message.stats)
    } else {
      this.statsEl.hide()
    }

    if (message.body) {
      this.noticeEl.show()
      this.noticeEl.empty()
      this.noticeEl.className = `op-progress-notice op-notice-${message.tone}`
      for (const paragraph of message.body.split('\n')) {
        this.noticeEl.createEl('p', { text: paragraph })
      }
    } else {
      this.noticeEl.hide()
    }

    this.paintProgress(status, running)
    this.appendLog(status)
    this.paintActions(status, message)
  }

  private paintProgress(status: SessionStatus, running: boolean): void {
    const { progress } = status

    // Past the result screen the live status line is noise: the headline
    // already says what happened.
    if (!running) {
      this.statusEl.hide()
      this.detailEl.hide()
      this.barEl.hide()
      this.countEl.setText('')
      return
    }

    this.statusEl.show()
    this.statusEl.setText(progress.message)

    if (progress.detail) {
      this.detailEl.show()
      this.detailEl.setText(progress.detail)
    } else {
      this.detailEl.hide()
    }

    if (typeof progress.current === 'number' && typeof progress.total === 'number' && progress.total > 0) {
      this.barEl.show()
      this.barFillEl.style.width = `${Math.round((progress.current / progress.total) * 100)}%`
      this.countEl.setText(`${progress.current} of ${progress.total}`)
    } else {
      this.barEl.hide()
      this.countEl.setText('')
    }
  }

  /**
   * Append-only, so repainting on every event stays cheap and the list does not
   * jump under the reader.
   */
  private appendLog(status: SessionStatus): void {
    const { progress } = status

    if (progress.skippedCount > 0) {
      // Files already in storage are the normal case, not news. Collapsing them
      // into one line keeps the actual uploads visible. Otherwise a one-file
      // publish looks like six files of work.
      if (!this.skippedEl) {
        this.skippedEl = this.logEl.createDiv({ cls: 'op-progress-log-row op-muted' })
        setIcon(this.skippedEl.createSpan({ cls: 'op-progress-log-icon' }), 'check')
        this.skippedEl.createSpan()
      }
      const label = this.skippedEl.lastElementChild as HTMLElement
      label.setText(
        progress.skippedCount === 1
          ? '1 file already in storage, skipped'
          : `${progress.skippedCount} files already in storage, skipped`,
      )
    }

    for (let index = this.renderedUploads; index < progress.uploadedPaths.length; index++) {
      const row = this.logEl.createDiv({ cls: 'op-progress-log-row' })
      setIcon(row.createSpan({ cls: 'op-progress-log-icon' }), 'upload')
      row.createSpan({ text: progress.uploadedPaths[index] })
    }
    if (progress.uploadedPaths.length > this.renderedUploads) {
      this.renderedUploads = progress.uploadedPaths.length
      this.logEl.scrollTop = this.logEl.scrollHeight
    }

    // The path list is capped; the count is not, so say what is missing rather
    // than letting the log quietly under-report a big first publish.
    if (progress.uploadedCount > progress.uploadedPaths.length && !this.moreEl) {
      this.moreEl = this.logEl.createDiv({ cls: 'op-muted' })
    }
    if (this.moreEl) {
      this.moreEl.setText(`…and ${progress.uploadedCount - progress.uploadedPaths.length} more.`)
    }
  }

  private paintActions(status: SessionStatus, message: PublishMessage): void {
    // Cancel disappears the moment there is nothing left to cancel.
    const buttons = message.buttons.filter((button) => button.id !== 'cancel' || status.cancellable)
    this.actionsEl.empty()
    for (const button of buttons) {
      const el = this.actionsEl.createEl('button', { text: button.label })
      if (button.primary) el.addClass('mod-cta')
      el.addEventListener('click', () => this.onAction(button.id))
    }
  }
}
