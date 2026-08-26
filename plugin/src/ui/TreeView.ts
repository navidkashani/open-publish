/**
 * A folder tree of vault paths, with ticks.
 *
 * The interaction rules are the whole substance of this file, and each one is
 * here because the obvious version is wrong:
 *
 *  - **The row is the hit target, not the little box.** Aiming at a 14px
 *    checkbox to say "yes, this note" is a needless test of dexterity.
 *  - **Nothing calls `preventDefault()` on a checkbox.** A checkbox flips
 *    itself *before* its click listeners run and, if the event is cancelled,
 *    flips back *after* they finish, silently undoing anything a listener
 *    assigned. That is what made a clicked file spring back to unticked while
 *    its parent folder lit up instead. Ticks are driven from `change` (which
 *    fires after the value settles) or from a click on the row, never both:
 *    a click whose target is the box is left for the box to handle.
 *  - **Collapsing is ours, not `<details>`.** A `<summary>` swallows clicks on
 *    the interactive things inside it in ways that differ per browser. A plain
 *    row and a hidden container behave the same everywhere.
 */

import { setIcon } from 'obsidian'
import { tickState, toggleNode } from './FileTree.ts'
import type { TreeNode } from './FileTree.ts'

export interface TreeViewOptions {
  /** Null for an information-only tree: no ticks, nothing to choose. */
  selected: Set<string> | null
  /** Called after any tick changes, so the owner can update its own totals. */
  onChange?: () => void
  /** Small right-hand label, e.g. `linked` for an auto-included attachment. */
  badge?: (path: string) => string | null
}

interface Tick {
  node: TreeNode
  input: HTMLInputElement
}

export class TreeView {
  private readonly container: HTMLElement
  private readonly nodes: TreeNode[]
  private readonly options: TreeViewOptions
  private readonly ticks: Tick[] = []

  constructor(container: HTMLElement, nodes: TreeNode[], options: TreeViewOptions) {
    this.container = container
    this.nodes = nodes
    this.options = options
  }

  render(): void {
    this.container.empty()
    this.container.addClass('op-tree')
    this.ticks.length = 0
    this.renderNodes(this.container, this.nodes)
    this.refresh()
  }

  /** Repaint every tick from the selection. Cheap enough to call on each click. */
  refresh(): void {
    const selected = this.options.selected
    if (!selected) return
    for (const { node, input } of this.ticks) {
      const state = tickState(node, selected)
      input.checked = state === 'on'
      input.indeterminate = state === 'partial'
    }
  }

  private renderNodes(container: HTMLElement, nodes: TreeNode[]): void {
    for (const node of nodes) {
      if (node.kind === 'file') {
        this.renderRow(container, node, null)
        continue
      }

      const item = container.createDiv({ cls: 'op-tree-item' })
      // The twisty is wired before the children exist, and only ever runs on a
      // click, by which time they do. Note it collapses the *children*, never
      // the folder's own row: hiding the row would take the twisty with it.
      let children: HTMLElement | null = null
      this.renderRow(item, node, () => children?.toggleClass('op-collapsed', !children.hasClass('op-collapsed')))
      children = item.createDiv({ cls: 'op-tree-children' })
      this.renderNodes(children, node.children)
    }
  }

  private renderRow(container: HTMLElement, node: TreeNode, onTwisty: (() => void) | null): HTMLElement {
    const row = container.createDiv({ cls: `op-tree-row op-row-${node.kind}` })

    const twisty = row.createSpan({ cls: 'op-twisty' })
    if (onTwisty) {
      twisty.addClass('op-twisty-open')
      setIcon(twisty, 'chevron-down')
      twisty.addEventListener('click', (event) => {
        // Without this the row's own handler would tick the folder as well.
        event.stopPropagation()
        twisty.toggleClass('op-twisty-open', !twisty.hasClass('op-twisty-open'))
        onTwisty()
      })
    }

    const selected = this.options.selected
    let input: HTMLInputElement | null = null
    if (selected) {
      input = row.createEl('input', { type: 'checkbox', cls: 'op-tree-tick' })
      this.ticks.push({ node, input })
      // `change`, not `click`: by the time change fires the checkbox has settled,
      // so nothing we write here gets reverted underneath us.
      input.addEventListener('change', () => this.toggle(node))
    }

    setIcon(row.createSpan({ cls: 'op-tree-icon' }), iconFor(node))

    const name = displayName(node)
    row.createSpan({ cls: 'op-tree-name', text: name.label })
    if (name.suffix) row.createSpan({ cls: 'op-tree-suffix', text: name.suffix })

    if (node.kind === 'folder') {
      // Only worth saying when it is not simply the row below. A "1" beside a
      // folder holding one visible file is noise on every line of the tree.
      if (node.files.length > 1) row.createSpan({ cls: 'op-tree-count', text: `${node.files.length}` })
    } else {
      const badge = this.options.badge?.(node.path)
      if (badge) row.createSpan({ cls: 'op-badge', text: badge })
    }

    if (selected) {
      row.addClass('op-tree-row-clickable')
      row.addEventListener('click', (event) => {
        // A click that landed on the box is the box's business; handling it here
        // too would toggle twice and land back where it started.
        if (event.target === input) return
        this.toggle(node)
      })
    }

    return row
  }

  private toggle(node: TreeNode): void {
    const selected = this.options.selected
    if (!selected) return
    toggleNode(node, selected)
    this.refresh()
    this.options.onChange?.()
  }
}

function iconFor(node: TreeNode): string {
  if (node.kind === 'folder') return 'folder'
  const lower = node.name.toLowerCase()
  if (lower.endsWith('.md')) return 'file-text'
  if (lower.endsWith('.canvas')) return 'layout-dashboard'
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(lower)) return 'image'
  if (/\.(mp4|webm|mov|ogv)$/.test(lower)) return 'film'
  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) return 'music'
  if (lower.endsWith('.pdf')) return 'file-type'
  return 'file'
}

/**
 * Notes show as their title; everything else keeps its extension, because for
 * an attachment the extension is half of what identifies it.
 */
function displayName(node: TreeNode): { label: string; suffix?: string } {
  if (node.kind === 'folder') return { label: node.name }
  const dot = node.name.lastIndexOf('.')
  if (dot <= 0) return { label: node.name }
  const extension = node.name.slice(dot)
  if (extension.toLowerCase() === '.md') return { label: node.name.slice(0, dot) }
  return { label: node.name.slice(0, dot), suffix: extension }
}
