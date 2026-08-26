/**
 * Background progress, for when the publish window is closed.
 *
 * This is the other half of moving the run off the modal: if closing the window
 * no longer cancels anything, something has to keep saying that work is still
 * happening. Without it, "close the window and carry on" would feel like the
 * publish evaporated.
 *
 * Hidden on mobile, which has no status bar at all, so nothing here is ever
 * the *only* place a result is reported. Notices cover that.
 */

import { Platform, setIcon, setTooltip } from 'obsidian'
import type { SessionStatus } from '../core/session.ts'
import type { MessageTone, PublishState } from './messages.ts'
import { publishMessage, statusBarLabel } from './messages.ts'

/** How long a finished run stays on the status bar before it clears itself. */
const LINGER_MS = 20_000

const ICONS: Record<MessageTone, string> = {
  info: 'upload-cloud',
  ok: 'check-circle',
  warning: 'alert-triangle',
  error: 'alert-circle',
}

export interface StatusBarHost {
  addStatusBarItem(): HTMLElement
}

export class StatusBar {
  private readonly el: HTMLElement | null
  private iconEl: HTMLElement | null = null
  private labelEl: HTMLElement | null = null
  private clearTimer: number | null = null

  constructor(host: StatusBarHost, onClick: () => void) {
    this.el = Platform.isMobile ? null : host.addStatusBarItem()
    if (!this.el) return
    this.el.addClass('op-status-bar')
    this.iconEl = this.el.createSpan({ cls: 'op-status-bar-icon' })
    this.labelEl = this.el.createSpan({ cls: 'op-status-bar-label' })
    this.el.addEventListener('click', onClick)
    this.el.hide()
  }

  update(status: SessionStatus | null, state: PublishState | null): void {
    if (!this.el || !this.labelEl || !this.iconEl) return
    this.cancelClear()

    if (!status || !state) {
      this.el.hide()
      return
    }

    const message = publishMessage(state)
    setIcon(this.iconEl, ICONS[message.tone])
    this.labelEl.setText(this.label(status, state))
    // Restored now that minAppVersion covers it. `setTooltip` was dropped for a
    // hand-written `aria-label` while hunting the dead-button bug; the attribute
    // works, but this is the API Obsidian actually maintains, and it keeps the
    // accessible name and the tooltip from drifting apart.
    setTooltip(this.el, [message.headline, message.stats, message.body].filter(Boolean).join(' '))
    this.el.toggleClass('op-status-bar-busy', status.state === 'running')
    this.el.show()

    // A finished run should not sit there forever, but it must sit there long
    // enough to be seen by someone who was in another app when it landed.
    if (status.state !== 'running') {
      this.clearTimer = window.setTimeout(() => {
        this.clearTimer = null
        this.el?.hide()
      }, LINGER_MS)
    }
  }

  private label(status: SessionStatus, state: PublishState): string {
    const base = statusBarLabel(state)
    const { current, total } = status.progress
    if (state.kind === 'publishing' && typeof current === 'number' && typeof total === 'number' && total > 0) {
      return `${base} ${current}/${total}`
    }
    return base
  }

  private cancelClear(): void {
    if (this.clearTimer === null) return
    window.clearTimeout(this.clearTimer)
    this.clearTimer = null
  }

  dispose(): void {
    this.cancelClear()
    this.el?.remove()
  }
}
