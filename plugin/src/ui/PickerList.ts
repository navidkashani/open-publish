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
 */

export interface PickerRow {
  id: string
  name: string
  recommended?: boolean
  /** One line: what this is, and what it costs. */
  summary: string
  /** The thing worth knowing before choosing, in the warning colour. */
  caution?: string
  /** A second muted line, where a row has one more thing to say. */
  extra?: string
}

export function renderPickerList(
  container: HTMLElement,
  rows: readonly PickerRow[],
  selected: string,
  onPick: (id: string) => void,
): void {
  const list = container.createDiv({ cls: 'op-provider-list' })
  for (const entry of rows) {
    const row = list.createEl('button', {
      cls: 'op-provider-row',
      attr: { type: 'button', 'aria-pressed': String(entry.id === selected) },
    })
    row.toggleClass('is-selected', entry.id === selected)

    const heading = row.createDiv({ cls: 'op-provider-heading' })
    heading.createSpan({ cls: 'op-provider-name', text: entry.name })
    if (entry.recommended) heading.createSpan({ cls: 'op-provider-badge', text: 'Recommended' })

    row.createDiv({ cls: 'op-provider-summary', text: entry.summary })
    if (entry.caution) row.createDiv({ cls: 'op-provider-caution-line', text: entry.caution })
    if (entry.extra) row.createDiv({ cls: 'op-provider-summary', text: entry.extra })

    row.addEventListener('click', () => onPick(entry.id))
  }
}
