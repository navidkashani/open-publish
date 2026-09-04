/** Just enough of the Obsidian API for the publish window to run under Node. */
import { StubElement, el } from './dom.mjs'

export const notices = []
/** Every menu ever opened, so a long-press can be checked without a device. */
export const menus = []
/** Every suggester ever constructed, keyed by the input it decorates. */
export const suggesters = []
/** Every modal ever constructed, so a dialog opened by another one can be reached. */
export const modals = []
/** Every secret field ever rendered, so a test can link and unlink one. */
export const secretFields = []

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
 * The real Modal assigns instance fields beyond the documented ones. `selection`
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
    modals.push(this)
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
  setTitle(title) {
    this.titleEl.setText(title)
    return this
  }
  onOpen() {}
  onClose() {}
}

/**
 * `Setting` builds a fixed element tree the plugin reaches into directly
 * (`nameEl` for a row's icon, `descEl` for its warning), so the tree is modelled
 * rather than faked: settingEl > infoEl > (nameEl, descEl), settingEl > controlEl.
 */
export class Setting {
  constructor(container) {
    this.settingEl = container.createDiv({ cls: 'setting-item' })
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' })
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' })
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' })
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' })
    this.errorEl = null
    this.components = []
  }
  setName(name) {
    this.nameEl.setText(name)
    return this
  }
  setDesc(desc) {
    this.descEl.setText(desc)
    return this
  }
  setHeading() {
    this.settingEl.addClass('setting-item-heading')
    return this
  }
  setClass(cls) {
    this.settingEl.addClass(cls)
    return this
  }
  setTooltip(tooltip) {
    this.settingEl.setAttr('aria-label', tooltip)
    return this
  }
  setDisabled(disabled) {
    this.settingEl.toggleClass('is-disabled', disabled)
    return this
  }
  setErrorMessage(message) {
    if (!message) {
      this.errorEl?.remove()
      this.errorEl = null
      this.settingEl.removeClass('is-invalid')
      return this
    }
    this.errorEl ??= this.infoEl.createDiv({ cls: 'setting-item-error' })
    this.errorEl.setText(message)
    this.settingEl.addClass('is-invalid')
    return this
  }

  addButton(build) {
    const buttonEl = this.controlEl.createEl('button')
    build(component(buttonEl, {
      setButtonText(text) {
        buttonEl.setText(text)
        return this
      },
      setCta() {
        buttonEl.addClass('mod-cta')
        return this
      },
      setWarning() {
        buttonEl.addClass('mod-warning')
        return this
      },
      setDestructive() {
        buttonEl.addClass('mod-destructive')
        return this
      },
    }))
    return this
  }

  addExtraButton(build) {
    const buttonEl = this.controlEl.createEl('button', { cls: 'clickable-icon extra-setting-button' })
    build(component(buttonEl, { extraSettingsEl: buttonEl }))
    return this
  }

  addToggle(build) {
    const inputEl = this.controlEl.createEl('input', { type: 'checkbox' })
    build(valueComponent(inputEl, 'checked'))
    return this
  }

  addText(build) {
    build(this.#textInput('text'))
    return this
  }

  /**
   * The escape hatch for components the Setting has no `addX` for, which is how
   * `SecretComponent` is reached: it needs the `App`, so it is constructed by
   * the caller rather than by the row. The real API hands the callback a fresh
   * child of `controlEl` and discards what comes back.
   */
  addComponent(build) {
    build(this.controlEl.createDiv({ cls: 'setting-item-control-component' }))
    return this
  }

  addSearch(build) {
    build(this.#textInput('search'))
    return this
  }

  addTextArea(build) {
    const inputEl = this.controlEl.createEl('textarea')
    build(valueComponent(inputEl, 'value'))
    return this
  }

  addDropdown(build) {
    const selectEl = this.controlEl.createEl('select')
    const dropdown = valueComponent(selectEl, 'value')
    // Real `DropdownComponent` exposes this, and code that repaints a dropdown
    // without redrawing the form around it needs the element itself.
    dropdown.selectEl = selectEl
    dropdown.addOptions = (options) => {
      for (const [value, label] of Object.entries(options)) selectEl.createEl('option', { text: label, attr: { value } })
      return dropdown
    }
    build(dropdown)
    return this
  }

  #textInput(type) {
    const inputEl = this.controlEl.createEl('input', { type })
    return valueComponent(inputEl, 'value')
  }
}

/** The bits every component shares: icon, tooltip, disabled, click. */
function component(element, extra) {
  const base = {
    setIcon(icon) {
      element.setAttr('data-icon', icon)
      return this
    },
    setTooltip(tooltip) {
      element.setAttr('aria-label', tooltip)
      return this
    },
    setDisabled(disabled) {
      element.disabled = disabled
      return this
    },
    onClick(handler) {
      element.addEventListener('click', handler)
      return this
    },
  }
  return Object.assign(base, extra)
}

function valueComponent(inputEl, field) {
  const self = component(inputEl, {
    inputEl,
    getValue() {
      return inputEl[field]
    },
    setValue(value) {
      inputEl[field] = value
      return self
    },
    setPlaceholder(placeholder) {
      inputEl.setAttr('placeholder', placeholder)
      return self
    },
    onChange(handler) {
      inputEl.addEventListener(field === 'checked' ? 'change' : 'input', () => handler(inputEl[field]))
      return self
    },
  })
  return self
}

/**
 * The keychain field, modelled on the one shipping in Obsidian rather than
 * imagined.
 *
 * Three things about the real component are load-bearing here and all three are
 * reproduced. Its value is the secret's *name*, never the secret. `setValue`
 * with a name the keychain does not hold draws exactly what a name that was
 * never set draws, which is why the form prints the name itself. And unlinking
 * calls `onChange(null)`, though the published type says `string`.
 */
export class SecretComponent {
  constructor(app, containerEl) {
    this.app = app
    this.containerEl = containerEl
    this.settingKey = ''
    this.disabled = false
    this.changeCallback = null
    this.valueEl = containerEl.createDiv({ cls: 'setting-secret-value' })
    this.buttonEl = containerEl.createEl('button', { text: 'Link' })
    secretFields.push(this)
  }
  setValue(id) {
    this.settingKey = id
    const value = id ? this.app.secretStorage.getSecret(id) : null
    // Blank for a name that does not resolve, exactly as the real one is.
    this.valueEl.setText(value === null ? '' : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022')
    this.buttonEl.setText(value === null ? 'Link' : 'Change')
    return this
  }
  onChange(callback) {
    this.changeCallback = callback
    return this
  }
  setDisabled(disabled) {
    this.disabled = disabled
    this.buttonEl.disabled = disabled
    return this
  }
  /** Test hook: pick a name in the chooser the button opens. */
  link(id) {
    this.setValue(id)
    this.changeCallback?.(id)
  }
  /** Test hook: the X beside a linked secret, which passes null. */
  unlink() {
    this.setValue(null)
    this.changeCallback?.(null)
  }
}

export class PopoverSuggest {}

/**
 * The popover's keyboard handling and its exact moment of writing the input are
 * not reproducible here, so they are not pretended at. What is modelled is the
 * contract the plugin actually depends on: `getSuggestions` is asked for a
 * query, and picking one runs `selectSuggestion`.
 */
export class AbstractInputSuggest extends PopoverSuggest {
  constructor(app, inputEl) {
    super()
    this.app = app
    this.inputEl = inputEl
    this.limit = 100
    suggesters.push(this)
  }
  setValue(value) {
    this.inputEl.value = String(value)
  }
  getValue() {
    return this.inputEl.value
  }
  open() {}
  close() {}
  onSelect(callback) {
    this._onSelect = callback
    return this
  }
  /** Test hook: what the popover would offer. */
  suggestionsFor(query) {
    return this.getSuggestions(query)
  }
  /** Test hook: click a row in the popover. */
  pick(value) {
    this.selectSuggestion(value, { type: 'click' })
  }
}

/** Honest enough to rank: a subsequence match, earlier and more contiguous scoring higher. */
export function prepareFuzzySearch(query) {
  const needle = query.toLowerCase().replace(/\s+/g, '')
  return (text) => {
    const haystack = text.toLowerCase()
    const matches = []
    let cursor = 0
    let contiguous = 0
    for (const char of needle) {
      const found = haystack.indexOf(char, cursor)
      if (found === -1) return null
      // Contiguous characters are reported as one range, not one range each.
      // Otherwise a highlight test cannot tell a run from a scattering.
      const last = matches.at(-1)
      if (last && last[1] === found) {
        last[1] = found + 1
        contiguous++
      } else {
        matches.push([found, found + 1])
      }
      cursor = found + 1
    }
    if (matches.length === 0) return { score: 0, matches: [] }
    return { score: contiguous - matches[0][0] / 100, matches }
  }
}

export function sortSearchResults(results) {
  results.sort((a, b) => b.match.score - a.match.score)
}

export function renderResults(element, text, result) {
  let cursor = 0
  for (const [start, end] of result.matches ?? []) {
    if (start > cursor) element.createSpan({ text: text.slice(cursor, start) })
    element.createSpan({ cls: 'suggestion-highlight', text: text.slice(start, end) })
    cursor = end
  }
  if (cursor < text.length) element.createSpan({ text: text.slice(cursor) })
}

export class Menu {
  constructor() {
    this.items = []
    this.shownAt = null
    menus.push(this)
  }
  setNoIcon() {
    return this
  }
  addItem(build) {
    const item = {
      title: '',
      icon: null,
      handler: null,
      setTitle(title) {
        item.title = title
        return item
      },
      setIcon(icon) {
        item.icon = icon
        return item
      },
      onClick(handler) {
        item.handler = handler
        return item
      },
    }
    build(item)
    this.items.push(item)
    return this
  }
  addSeparator() {
    return this
  }
  showAtPosition(position) {
    this.shownAt = position
    return this
  }
  showAtMouseEvent(event) {
    this.shownAt = { x: event.clientX ?? 0, y: event.clientY ?? 0 }
    return this
  }
  hide() {
    return this
  }
  close() {}
}

/**
 * Obsidian's HTTP call, present so that `main.ts` can be loaded at all.
 *
 * It refuses by default rather than answering, because a stub that quietly
 * returns 200 would let a test believe it had reached storage. A test that
 * wants a reply installs one; the destination tests use the injected
 * `HttpClient` instead and never come through here.
 */
export const requests = []
let responder = () => {
  throw new Error('requestUrl: no response configured for this test')
}
export function requestUrl(request) {
  requests.push(request)
  return Promise.resolve(responder(request))
}
requestUrl.respondWith = (next) => {
  responder = next
}

export function setIcon(element, name) {
  element.setAttr('data-icon', name)
}

export function setTooltip(element, tooltip) {
  element.setAttr('aria-label', tooltip)
}

/** Mutable: modules must read `Platform.isMobile` when they render, not at import. */
export const Platform = { isMobile: false, isPhone: false, isTablet: false, isDesktopApp: true, isMobileApp: false }

class TAbstractFile {
  constructor(path) {
    this.path = path
    this.name = path.split('/').pop() ?? ''
  }
}

export class TFolder extends TAbstractFile {
  constructor(path) {
    super(path)
    this.children = []
  }
  isRoot() {
    return this.path === '/'
  }
}

export class TFile extends TAbstractFile {
  constructor(path) {
    super(path)
    const dot = this.name.lastIndexOf('.')
    this.extension = dot > 0 ? this.name.slice(dot + 1) : ''
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name
    this.stat = { size: 0, mtime: 0, ctime: 0 }
  }
}

export class Plugin {}

/**
 * A sub-page of a setting tab, as `SettingDefinitionPage.page` builds one.
 *
 * The element tree is modelled because a subclass renders into `containerEl`
 * and a test then reads what it drew, which is how the storage and build forms
 * are still reachable now that each lives on its own page.
 */
export class SettingPage {
  constructor() {
    this.rootEl = el()
    this.titlebarEl = this.rootEl.createDiv({ cls: 'setting-page-titlebar' })
    this.containerEl = this.rootEl.createDiv({ cls: 'setting-page-content' })
    this.title = ''
  }
  display() {}
  hide() {}
}

/** The second argument a `render:` definition is handed. Nothing here uses it yet. */
export class SettingGroup {
  constructor(containerEl) {
    this.listEl = containerEl.createDiv({ cls: 'setting-group' })
  }
  setHeading(text) {
    this.listEl.createDiv({ cls: 'setting-item-heading', text })
    return this
  }
  addClass(...classes) {
    for (const cls of classes) this.listEl.addClass(cls)
    return this
  }
  addSetting(build) {
    build(new Setting(this.listEl))
    return this
  }
  addSearch(build) {
    build(valueComponent(this.listEl.createEl('input', { type: 'search' }), 'value'))
    return this
  }
  addExtraButton(build) {
    const buttonEl = this.listEl.createEl('button', { cls: 'clickable-icon extra-setting-button' })
    build(component(buttonEl, { extraSettingsEl: buttonEl }))
    return this
  }
}

/**
 * The tab, with the 1.13 declarative surface and **deliberately no renderer**.
 *
 * `update()` stores the definitions and nothing more. Faking Obsidian's
 * definitions-to-DOM pass here would be a second copy of a shipped feature,
 * free to drift from the one users get, which is the thing `README.md` says
 * this test suite exists to avoid. So a test asserts the tree as data, and
 * reaches DOM only through the `render:` callbacks and `page()` factories that
 * are the plugin's own code either way.
 */
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app
    this.plugin = plugin
    this.containerEl = el()
    /** The sidebar icon. Real since 1.11.0; a subclass assigns it in its constructor. */
    this.icon = null
    /** Populated by update(), as the real one is. */
    this.settingItems = []
  }
  getSettingDefinitions() {
    return []
  }
  update() {
    this.settingItems = this.getSettingDefinitions()
  }
  /** The documented defaults: a flat key against `plugin.settings`. Both are overridden here. */
  getControlValue(key) {
    return this.plugin.settings?.[key]
  }
  setControlValue(key, value) {
    if (this.plugin.settings) this.plugin.settings[key] = value
  }
  /** Cheap in the app, and nothing at all here: there is no rendered DOM to refresh. */
  refreshDomState() {}
  display() {}
  hide() {}
}

export function normalizePath(path) {
  const cleaned = path
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .normalize('NFC')
  return cleaned === '' ? '/' : cleaned
}

export { StubElement }
