/**
 * A DOM small enough to run the publish window under `node --test`.
 *
 * The point is not coverage for its own sake. It is that the interesting bugs
 * in a tree of checkboxes are *interaction* bugs, and those are invisible to a
 * unit test of the tree logic. So this models the parts of the platform that
 * actually bite:
 *
 *  - events bubble, and `stopPropagation` / `preventDefault` mean what they mean
 *  - a checkbox flips its own `checked` **before** the click listeners run, and
 *    `preventDefault()` puts it back **after** they finish (the spec's
 *    "canceled activation steps"). Anything a listener assigned in between is
 *    silently reverted, which is exactly the kind of thing you only find by
 *    clicking.
 */

class StubEvent {
  constructor(type) {
    this.type = type
    this.target = null
    this.currentTarget = null
    this.defaultPrevented = false
    this._stopped = false
  }
  preventDefault() {
    this.defaultPrevented = true
  }
  stopPropagation() {
    this._stopped = true
  }
}

class StubClassList {
  constructor() {
    this._set = new Set()
  }
  add(...names) {
    for (const name of names) this._set.add(name)
  }
  remove(...names) {
    for (const name of names) this._set.delete(name)
  }
  contains(name) {
    return this._set.has(name)
  }
  toggle(name, force) {
    const on = force ?? !this._set.has(name)
    if (on) this._set.add(name)
    else this._set.delete(name)
    return on
  }
  get value() {
    return [...this._set].join(' ')
  }
}

export class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.classList = new StubClassList()
    this.listeners = new Map()
    this.style = {}
    this.ownText = ''
    this.hidden = false
    this.value = ''
    this.checked = false
    this.indeterminate = false
    this.disabled = false
    this.type = ''
    this.scrollTop = 0
    this.scrollHeight = 0
  }

  // --- structure ---
  appendChild(child) {
    child.parentElement?.removeChild(child)
    child.parentElement = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentElement = null
  }
  remove() {
    this.parentElement?.removeChild(this)
  }
  detach() {
    this.remove()
  }
  empty() {
    for (const child of [...this.children]) child.parentElement = null
    this.children.length = 0
    this.ownText = ''
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null
  }
  get firstElementChild() {
    return this.children[0] ?? null
  }
  get textContent() {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  // --- Obsidian's element sugar ---
  createEl(tag, options = {}) {
    const el = new StubElement(tag)
    if (options.cls) for (const name of String(options.cls).split(/\s+/).filter(Boolean)) el.classList.add(name)
    if (options.text !== undefined) el.ownText = String(options.text)
    if (options.type) el.type = options.type
    if (options.attr) for (const [key, value] of Object.entries(options.attr)) el.setAttr(key, value)
    if (options.href) el.setAttr('href', options.href)
    return this.appendChild(el)
  }
  createDiv(options) {
    return this.createEl('div', options)
  }
  createSpan(options) {
    return this.createEl('span', options)
  }
  setText(text) {
    this.empty()
    this.ownText = String(text)
  }
  addClass(...names) {
    this.classList.add(...names)
  }
  removeClass(...names) {
    this.classList.remove(...names)
  }
  hasClass(name) {
    return this.classList.contains(name)
  }
  toggleClass(names, value) {
    for (const name of [].concat(names)) this.classList.toggle(name, value)
  }
  setAttr(key, value) {
    this.attributes.set(key, String(value))
  }
  getAttr(key) {
    return this.attributes.get(key) ?? null
  }
  getAttribute(key) {
    return this.getAttr(key)
  }
  hasAttribute(key) {
    return this.attributes.has(key)
  }
  removeAttribute(key) {
    this.attributes.delete(key)
  }
  show() {
    this.hidden = false
  }
  hide() {
    this.hidden = true
  }
  /**
   * Obsidian's own `HTMLElement.toggle(show)`, not `classList.toggle`. It is
   * plain visibility, and the settings tab uses it to hide the analytics ID
   * field, so without it `display()` throws before rendering anything.
   */
  toggle(show) {
    this.hidden = !show
  }
  /**
   * Only the two positions the plugin uses. A `beforebegin` insert is a *move*
   * when the element already has a parent, which is the case the settings tab
   * relies on to put a dropdown above the field it governs.
   */
  insertAdjacentElement(position, element) {
    element.parentElement?.removeChild(element)
    if (position === 'beforebegin' || position === 'afterend') {
      const parent = this.parentElement
      if (!parent) throw new Error(`insertAdjacentElement("${position}") on a node with no parent`)
      const index = parent.children.indexOf(this)
      parent.children.splice(position === 'beforebegin' ? index : index + 1, 0, element)
      element.parentElement = parent
      return element
    }
    if (position === 'afterbegin') {
      this.children.unshift(element)
      element.parentElement = this
      return element
    }
    if (position === 'beforeend') return this.appendChild(element)
    throw new Error(`unsupported insertAdjacentElement position "${position}"`)
  }
  set className(value) {
    this.classList = new StubClassList()
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classList.add(name)
  }
  get className() {
    return this.classList.value
  }

  // --- events ---
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }
  dispatchEvent(event) {
    event.target ??= this
    let node = this
    while (node) {
      event.currentTarget = node
      for (const handler of [...(node.listeners.get(event.type) ?? [])]) handler.call(node, event)
      if (event._stopped) break
      node = node.parentElement
    }
    return !event.defaultPrevented
  }
}

export function el(tag = 'div') {
  return new StubElement(tag)
}

/**
 * Dispatch an arbitrary event with extra properties on it (pointer
 * coordinates, a key name), so gestures and keyboard handling are drivable
 * without a device or a real DOM.
 */
export function dispatch(target, type, props = {}) {
  const event = Object.assign(new StubEvent(type), props)
  target.dispatchEvent(event)
  return event
}

/**
 * Click something the way a browser does.
 *
 * The checkbox dance is the whole reason this exists: flip first, dispatch,
 * then either revert (cancelled) or fire `change` (not cancelled).
 */
export function click(target) {
  const isCheckbox = target.tagName === 'INPUT' && target.type === 'checkbox'
  const before = { checked: target.checked, indeterminate: target.indeterminate }

  if (isCheckbox) {
    target.checked = !target.checked
    target.indeterminate = false
  }

  const event = new StubEvent('click')
  target.dispatchEvent(event)

  if (!isCheckbox) return event
  if (event.defaultPrevented) {
    target.checked = before.checked
    target.indeterminate = before.indeterminate
  } else {
    target.dispatchEvent(new StubEvent('change'))
  }
  return event
}

/** Depth-first search over rendered elements. */
export function find(root, predicate) {
  if (predicate(root)) return root
  for (const child of root.children) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return null
}

export function findAll(root, predicate, out = []) {
  if (predicate(root)) out.push(root)
  for (const child of root.children) findAll(child, predicate, out)
  return out
}

export const byClass = (name) => (node) => node.hasClass(name)
export const byText = (text) => (node) => node.textContent === text

/**
 * There is no CSS here, so visibility has to be modelled explicitly: an element
 * is hidden by `hide()`, or by the one class the stylesheet hides
 * (`.op-collapsed { display: none }`), or by any ancestor in either state.
 */
export const HIDDEN_CLASS = 'op-collapsed'
export const visible = (node) => {
  let current = node
  while (current) {
    if (current.hidden || current.hasClass(HIDDEN_CLASS)) return false
    current = current.parentElement
  }
  return true
}
