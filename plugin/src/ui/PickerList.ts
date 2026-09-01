/**
 * The picker: a row list, not a tile grid.
 *
 * Written for storage, now shared with hosting, because the two lists want the
 * identical thing: a name, a badge on at most one of them, a line about what it
 * costs, and a line about what to watch out for.
 *
 * Obsidian's settings column is narrow and the wizard is already a scrolling
 * modal, so a grid would collapse to a list on anything small and cost a media
 * query to buy nothing. Each row is a real button with `aria-pressed` rather
 * than a radiogroup: correct radio semantics need roving tabindex and arrow
 * keys, and a half-built radiogroup is worse for a screen reader than plain
 * buttons.
 *
 * No logos and no glyphs. One identical icon on six rows is decoration, six
 * different ones are a decoder ring with no key, and Obsidian hides settings
 * icons for the whole community-plugins group anyway.
 *
 * The one mark on every row is not a counter-example to that. `op-picker-mark`
 * is drawn from `is-selected` and says *which one is chosen*, which is state,
 * not decoration: a faint background tint and one accent-coloured word were the
 * only cues before it, and on a two-row list neither reads as a choice. It is
 * visual only. `aria-pressed` remains the truth a screen reader is told.
 */

export interface PickerRow {
  id: string
  name: string
  recommended?: boolean
  /** Overrides the badge text. `recommended` is the shorthand for "Recommended". */
  badge?: string
  /** One line: what this is, and what it costs. */
  summary: string
  /** The thing worth knowing before choosing, in the warning colour. */
  caution?: string
  /** A second muted line, where a row has one more thing to say. */
  extra?: string
  /**
   * Shown, but not choosable.
   *
   * Listed rather than hidden because "that version is not here" is an answer,
   * and a history with silent gaps in it is one people assume is complete.
   * `caution` carries the reason.
   */
  disabled?: boolean
}

export function renderPickerList(
  container: HTMLElement,
  rows: readonly PickerRow[],
  selected: string,
  onPick: (id: string) => void,
  /** Drawn once, in a panel joined to the selected row. Omit for a plain list. */
  renderDetail?: (container: HTMLElement) => void,
): void {
  const list = container.createDiv({ cls: 'op-provider-list' })
  for (const entry of rows) {
    const isSelected = entry.id === selected
    const row = list.createEl('button', {
      cls: 'op-provider-row',
      attr: { type: 'button', 'aria-pressed': String(isSelected) },
    })
    row.toggleClass('is-selected', isSelected)
    row.toggleClass('is-unavailable', entry.disabled === true)
    // Disabled in the DOM *and* checked in the handler: the attribute is what a
    // keyboard and a screen reader read, and the check is what holds if some
    // caller ever dispatches a click at it directly.
    if (entry.disabled) {
      row.setAttr('disabled', 'true')
      row.setAttr('aria-disabled', 'true')
    }

    row.createSpan({ cls: 'op-picker-mark' })
    // Everything the row says lives in the second grid column, beside the mark.
    const body = row.createDiv({ cls: 'op-picker-body' })

    const heading = body.createDiv({ cls: 'op-provider-heading' })
    heading.createSpan({ cls: 'op-provider-name', text: entry.name })
    const badge = entry.badge ?? (entry.recommended ? 'Recommended' : null)
    if (badge) heading.createSpan({ cls: 'op-provider-badge', text: badge })

    body.createDiv({ cls: 'op-provider-summary', text: entry.summary })
    if (entry.caution) body.createDiv({ cls: 'op-provider-caution-line', text: entry.caution })
    if (entry.extra) body.createDiv({ cls: 'op-provider-summary', text: entry.extra })

    row.addEventListener('click', () => {
      if (entry.disabled) return
      onPick(entry.id)
    })

    // A sibling of the row, not a child of it: the row is a `<button>`, and a
    // link inside a button is invalid and would be swallowed by it. The panel
    // is joined to its row in CSS instead, by sharing the background and
    // dropping the border between the two.
    if (renderDetail && isSelected) renderDetail(list.createDiv({ cls: 'op-picker-detail' }))
  }
}
