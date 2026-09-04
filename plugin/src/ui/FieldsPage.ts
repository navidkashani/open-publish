/**
 * A settings sub-page whose body is drawn by hand.
 *
 * The storage and build forms are shared with the setup wizard, where there is
 * no definition tree to render into: they take a container and draw into it.
 * That contract is the whole reason there is one copy of each form rather than
 * two, so rather than convert them, this wraps them.
 * `SettingDefinitionPage.page` exists for exactly this case.
 *
 * The price is stated where the entry is built: rows drawn this way are not
 * individually indexed by Obsidian's settings search, which is what the
 * `aliases` on the page entry answer for.
 */

import { SettingPage } from 'obsidian'

export class FieldsPage extends SettingPage {
  private readonly draw: (host: HTMLElement) => void

  constructor(title: string, draw: (host: HTMLElement) => void) {
    super()
    // Assigned rather than declared: `title` is a base-class property, and a
    // field declaration here would ask for an `override` keyword it cannot have.
    this.title = title
    this.draw = draw
  }

  display(): void {
    this.containerEl.empty()
    this.draw(this.containerEl)
  }
}
