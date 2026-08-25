/** Just enough of the Obsidian API for the publish window to run under Node. */
import { StubElement, el } from './dom.mjs'

export const notices = []

export class Notice {
  constructor(message) {
    this.message = message
    notices.push(message)
  }
  hide() {}
  setMessage(message) {
    this.message = message
  }
}

/**
 * The real Modal assigns instance fields beyond the documented ones — `selection`
 * is the one that has bitten us, because it silently shadows a subclass method
 * of the same name with no type error. It is set here so the collision is
 * reproducible, and `MODAL_MEMBERS` below is asserted against in the tests.
 */
export const MODAL_MEMBERS = [
  'app',
  'scope',
  'containerEl',
  'modalEl',
  'titleEl',
  'contentEl',
  'shouldRestoreSelection',
  'selection',
  'open',
  'close',
  'setTitle',
  'setContent',
  'setCloseCallback',
]

export class Modal {
  constructor(app) {
    this.app = app
    this.containerEl = el()
    this.modalEl = el()
    this.titleEl = el()
    this.contentEl = el()
    this.shouldRestoreSelection = false
    this.selection = null
    this.isOpen = false
  }
  open() {
    this.isOpen = true
    this.onOpen()
  }
  close() {
    this.isOpen = false
    this.onClose()
  }
  onOpen() {}
  onClose() {}
}

export class Setting {
  constructor(container) {
    this.settingEl = container.createDiv({ cls: 'setting-item' })
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' })
  }
  setName(name) {
    this.settingEl.createDiv({ cls: 'setting-item-name', text: name })
    return this
  }
  setDesc(desc) {
    this.settingEl.createDiv({ cls: 'setting-item-description', text: desc })
    return this
  }
  addButton(build) {
    const buttonEl = this.controlEl.createEl('button')
    build({
      setButtonText(text) {
        buttonEl.setText(text)
        return this
      },
      onClick(handler) {
        buttonEl.addEventListener('click', handler)
        return this
      },
      setCta() {
        buttonEl.addClass('mod-cta')
        return this
      },
    })
    return this
  }
}

export function setIcon(element, name) {
  element.setAttr('data-icon', name)
}

export const Platform = { isMobile: false }

export class TFile {}
export class Plugin {}
export function normalizePath(path) {
  return path
}

export { StubElement }
