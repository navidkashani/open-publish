/**
 * The "Advanced" disclosure, and the one validation rule that goes with it.
 *
 * Both were written for the storage form and are now wanted by the build form
 * too. Copying them would mean two sets of `aria-expanded` wiring drifting
 * apart, and the wiring is the part that is easy to get subtly wrong.
 *
 * The rule the disclosure exists to keep: **nothing the user chose is ever
 * hidden.** It starts closed only when everything inside it holds a default,
 * and its label says what is in there when it does not.
 */

import type { Setting } from 'obsidian'

/**
 * `Advanced`, or `Advanced · key prefix "notes"`, or `Advanced · 2 settings changed`.
 *
 * One changed field is named, because naming it is what makes a closed section
 * safe. Two or more are counted, because a label is not a list.
 */
export function advancedLabel(changes: readonly string[]): string {
  if (changes.length === 0) return 'Advanced'
  if (changes.length === 1) return `Advanced · ${changes[0]}`
  return `Advanced · ${changes.length} settings changed`
}

let sectionCounter = 0

export interface Disclosure {
  /** Where the rows go. */
  body: HTMLElement
  /** Call when the contents change, so a closed section is never opaque. */
  setLabel: (label: string) => void
}

export function renderDisclosure(container: HTMLElement, label: string, startOpen: boolean): Disclosure {
  const bodyId = `op-advanced-${++sectionCounter}`

  const toggle = container.createEl('button', {
    cls: 'op-advanced-toggle',
    text: label,
    attr: { type: 'button', 'aria-expanded': String(startOpen), 'aria-controls': bodyId },
  })

  const body = container.createDiv({ cls: 'op-advanced', attr: { id: bodyId } })
  body.toggleClass('op-collapsed', !startOpen)

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttr('aria-expanded', String(open))
    body.toggleClass('op-collapsed', !open)
  })

  return { body, setLabel: (next: string) => toggle.setText(next) }
}

/**
 * On blur, never on change.
 *
 * Validating per keystroke flashes an error for the first thirty-one characters
 * of a correct thirty-two character account ID, which teaches people to ignore
 * the error. An empty field is not yet filled in, which is not the same as
 * wrong, so it is left alone too.
 */
export function validateOnBlur(setting: Setting, input: HTMLInputElement, pattern: RegExp, message: string): void {
  input.addEventListener('blur', () => {
    const value = input.value.trim()
    setting.setErrorMessage(!value || pattern.test(value) ? null : message)
  })
}
