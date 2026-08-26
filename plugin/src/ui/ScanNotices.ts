/**
 * The two things a scan has to say that are not "here is what changed".
 *
 * They live here rather than in `ReviewView` because two screens now show
 * them: the review, and the up-to-date screen that used to drop them on the
 * floor. A vault whose links are broken is in its *steady* state (nothing to
 * publish, and something to fix), so the screen that says "nothing to publish"
 * is exactly the one that has to offer the fix.
 *
 * One copy, so the wording cannot drift between the two.
 */

import { Setting } from 'obsidian'
import type { ScanBlocker } from '../core/scanner.ts'

export interface ScanNotices {
  blockers: readonly ScanBlocker[]
  warnings: readonly string[]
}

/** Hard stops first, then the soft ones. Nothing is rendered when both are empty. */
export function renderScanNotices(container: HTMLElement, scan: ScanNotices): void {
  if (scan.blockers.length > 0) {
    const box = container.createDiv({ cls: 'op-notice-error op-blockers' })
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
    container.createDiv({ cls: 'op-notice-warning', text: warning })
  }
}

/**
 * "Add linked", the only route to the fix documented for a link that renders as
 * plain text.
 *
 * `op-offer` drops the row's own top border: whichever screen this lands on
 * draws one rule above the group, and a second one a few pixels below it is the
 * pile the redesign exists to remove.
 */
export function renderLinkedNotes(
  container: HTMLElement,
  paths: readonly string[],
  onAdd: (paths: string[]) => void,
): void {
  if (paths.length === 0) return

  new Setting(container)
    .setClass('op-offer')
    .setName('Linked notes that are not published')
    .setDesc(
      `${paths.length} note(s) are linked from your published notes but are not published themselves. ` +
        'Right now those links render as plain text. Adding them publishes them too.',
    )
    .addButton((button) =>
      button.setButtonText('Add linked').onClick(() => {
        onAdd([...paths])
      }),
    )
}
