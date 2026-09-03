/**
 * The customise-navigation dialog: what order the sidebar is in, and what is
 * left out of it.
 *
 * Four things about it are decisions rather than details.
 *
 *  - **Drag, and a pair of buttons beside every row.** Dragging is what Obsidian
 *    Publish offers and the gesture people arrive expecting, but it fires on no
 *    touch screen and cannot be driven from a keyboard. WCAG 2.2 SC 2.5.7 makes
 *    that a Level AA requirement rather than a preference: any function using a
 *    dragging movement needs a single-pointer alternative, and its worked
 *    example is this exact control, "adjacent controls for moving the element up
 *    or down in the list". It also says outright that a keyboard equivalent does
 *    not satisfy it. So the buttons are not a concession to phones; they are
 *    what makes shipping the drag admissible at all. Both reach one rule,
 *    `moveInto`, so there is a single place that decides where a row lands and a
 *    single place that writes it down.
 *  - **Within a parent only.** Moving a note between folders would move the
 *    note, and this dialog never writes to the vault. So a row can rise and fall
 *    among its siblings and nothing else, which is also the limit Publish's own
 *    manager has. It is why the drop marker is a line rather than a highlighted
 *    row: see `showDropLine`.
 *  - **A row that frontmatter has already decided says so and stops.** A note
 *    carrying `nav-order:` cannot be arranged from here, because frontmatter
 *    wins; offering a control that silently loses is worse than offering none.
 *    That holds for a drop onto it as much as for its own buttons.
 *  - **Every change redraws the whole tree, so the dialog has to remember three
 *    things across a redraw**: which folders are open, where focus was, and what
 *    just happened. Without the first, arranging a folder of ten would be twenty
 *    clicks of re-opening it. Without the second, a keyboard user gets exactly
 *    one Move down and then Tabs back from the top. Without the third, a screen
 *    reader is given no sign that anything moved at all, and a drag has no other
 *    feedback to offer one.
 *
 * The arithmetic is all in `core/navorder.ts`, which has no DOM and no Obsidian.
 * This file is the wiring.
 */

import { Menu, Modal, Platform, Setting, setIcon } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { noteMetadata, resolverFromApp } from '../core/linkindex.ts'
import { NAV_WARN_ENTRIES, buildNavTree, readNavHidden, readNavOrder } from '../core/navorder.ts'
import type { NavNode, NavNote, NavSettings } from '../core/navorder.ts'
import { isAlwaysExcluded } from '../core/selection.ts'
import { slugForPath } from '../core/slug.ts'
import { attachLongPress } from './longpress.ts'

/** Cleans up anything that outlives a re-render. */
type Disposer = () => void

/**
 * Which control a change came from, so focus can be put back on it.
 *
 * `row` is the drag, which has no button to return to, and is also where a move
 * falls back when the button it came from has since been disabled.
 */
type NavControl = 'up' | 'down' | 'hide' | 'row'

export const NAV_INTRO =
  'Put the pages in your site navigation in the order you want, and leave any of them out of it. ' +
  'Drag a page onto the one whose place you want it to take, or use the arrows beside it. ' +
  'A note with a nav-order in its frontmatter is arranged by that instead, and says so below.'

/**
 * Said in the dialog rather than left for somebody to discover, because
 * "hidden" is a word people reasonably read as "protected". It is not, and
 * docs/security.md is blunt about not letting a word do work the code does not.
 */
export const NAV_HIDDEN_WARNING =
  'Hiding a page only takes it out of the navigation. It is still published, still found by search, ' +
  'and still there for anyone with the address. Hiding a folder takes everything inside it out of the ' +
  'navigation too, and those pages stay published just the same.'

export const NAV_RESTORE_DESC =
  'Forget the order and the hidden pages set here, and go back to folders first, then notes, ' +
  'alphabetically. Any nav-order or nav-hidden written in a note is untouched: those live in your notes.'

/** Past this the order stops being free, and it is charged per page. See `NAV_WARN_ENTRIES`. */
export function navSizeWarning(entries: number): string | null {
  if (entries <= NAV_WARN_ENTRIES) return null
  return (
    `${entries} pages are arranged by hand. A site theme may have to carry that order on every page it ` +
    'builds, so an arrangement this large makes every page of your site a little heavier. Arranging only ' +
    'the folders you care about costs nothing for the rest.'
  )
}

export class NavigationModal extends Modal {
  private readonly plugin: OpenPublishPlugin
  private readonly onDone: () => void
  private disposers: Disposer[] = []
  /** Off shows the sidebar as a visitor sees it; on is how anything gets un-hidden. */
  private showHidden = true
  /**
   * Which folders are open, by node key.
   *
   * Folders start closed, the way Publish's panel does, so a 96-note vault opens
   * showing its shape rather than a wall of rows. That only works if the open
   * ones survive a redraw, and every move and every hide redraws: without this
   * the tree would slam shut under the row somebody was moving, and arranging a
   * folder of ten would be twenty clicks of re-opening it. Two folders can never
   * share a key, so a rename mid-session cannot confuse it, and the set is
   * thrown away when the dialog closes.
   */
  private expanded = new Set<string>()
  /** The row a drag is carrying, or null. No `dataTransfer`: see `attachDrag`. */
  private dragging: NavNode | null = null
  /** The row currently showing an insertion line, so it can be cleared. */
  private dropRow: HTMLElement | null = null
  /** Where to put focus once `render` has rebuilt the row that was acted on. */
  private restoreFocus: { key: string; control: NavControl } | null = null
  /** The row that just moved, announced once the redraw knows where it landed. */
  private moved: NavNode | null = null
  /** This render's controls, by node key and control, for `applyFocus`. */
  private focusables = new Map<string, HTMLElement>()
  /** This render's positions, as "2 of 5", by node key. */
  private places = new Map<string, string>()
  /**
   * The live region, deliberately outside `contentEl`.
   *
   * `render` empties `contentEl`, and a live region created in the same breath
   * as the words it carries is a region no screen reader has seen change: it
   * announces nothing. So it is made once, beside the content rather than in it,
   * and only its text ever changes.
   */
  private liveEl: HTMLElement | null = null

  // Written out rather than as constructor parameter properties: Node's
  // type-stripping cannot erase those, and the test suite runs this file.
  constructor(app: App, plugin: OpenPublishPlugin, onDone: () => void = () => {}) {
    super(app)
    this.plugin = plugin
    this.onDone = onDone
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.setTitle('Customize navigation')
    this.liveEl = this.modalEl.createDiv({
      cls: 'op-sr-only',
      attr: { 'aria-live': 'polite', 'aria-atomic': 'true' },
    })
    this.render()
  }

  override onClose(): void {
    this.dispose()
    this.contentEl.empty()
    this.liveEl = null
    this.onDone()
  }

  private dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers = []
  }

  private get nav(): NavSettings {
    // Defaulted rather than assumed: `migrateSettings` always writes this, and
    // a dialog that throws on a hand-edited data.json helps nobody.
    const site = this.plugin.settings.site
    site.nav ??= { order: [], hidden: [] }
    return site.nav
  }

  /**
   * Redraw first, then persist.
   *
   * That order rather than the other way round because the settings object is
   * already the new answer by the time this is called: waiting on the write
   * would leave a row visibly in its old place for as long as the disk takes,
   * on a screen whose entire subject is where things are.
   */
  private apply(): void {
    this.render()
    void this.plugin.saveSettings()
  }

  private render(): void {
    this.dispose()
    this.clearDropLine()
    this.focusables.clear()
    this.places.clear()
    const { contentEl } = this
    contentEl.empty()

    const notes = this.publishedNotes()
    const tree = buildNavTree(notes, this.nav)

    contentEl.createEl('p', { cls: 'op-rule-intro', text: NAV_INTRO })

    if (notes.length === 0) {
      contentEl.createDiv({
        cls: 'op-muted op-rule-empty',
        text: 'Nothing is being published yet, so there is no navigation to arrange.',
      })
      return
    }

    new Setting(contentEl)
      .setName('Show hidden pages')
      .setDesc('Turn this off to see the navigation the way a visitor does.')
      .addToggle((toggle) =>
        toggle.setValue(this.showHidden).onChange((value) => {
          this.showHidden = value
          this.render()
        }),
      )

    const list = contentEl.createDiv({ cls: 'op-tree op-nav-tree' })
    this.renderNodes(list, tree)

    contentEl.createEl('p', { cls: 'op-nav-note', text: NAV_HIDDEN_WARNING })

    const warning = navSizeWarning(this.nav.order.length)
    if (warning) {
      const banner = contentEl.createDiv({ cls: 'op-nav-warning' })
      setIcon(banner.createSpan({ cls: 'op-rule-warning-icon' }), 'alert-triangle')
      banner.createSpan({ text: warning })
    }

    const arranged = this.nav.order.length + this.nav.hidden.length
    new Setting(contentEl)
      .setName('Restore default')
      .setDesc(NAV_RESTORE_DESC)
      .addButton((button) =>
        button
          .setButtonText('Restore default')
          .setDisabled(arranged === 0)
          .setWarning()
          .onClick(() => {
            this.nav.order = []
            this.nav.hidden = []
            this.apply()
          }),
      )

    // Both of these are about the redraw that has just happened, so they are the
    // last thing it does: the row that was acted on exists again by now, and
    // knows where it ended up.
    this.announceMove()
    this.applyFocus()
  }

  private renderNodes(container: HTMLElement, siblings: NavNode[]): void {
    const shown = siblings.filter((node) => this.showHidden || !node.hidden)
    for (const [index, node] of shown.entries()) {
      // What the announcement will say, recorded where a row's place is actually
      // known: after the arithmetic, and over the rows on screen rather than the
      // ones the settings happen to name.
      this.places.set(node.key, `${index + 1} of ${shown.length}`)

      if (!node.isFolder) {
        this.renderRow(container, node, siblings, null)
        continue
      }

      const item = container.createDiv({ cls: 'op-tree-item' })
      const open = this.expanded.has(node.key)
      let children: HTMLElement | null = null
      this.renderRow(item, node, siblings, {
        open,
        toggle: () => {
          const nowOpen = !this.expanded.has(node.key)
          if (nowOpen) this.expanded.add(node.key)
          else this.expanded.delete(node.key)
          children?.toggleClass('op-collapsed', !nowOpen)
          return nowOpen
        },
      })
      children = item.createDiv({ cls: 'op-tree-children' })
      if (!open) children.addClass('op-collapsed')
      this.renderNodes(children, node.children)
    }
  }

  private renderRow(
    container: HTMLElement,
    node: NavNode,
    siblings: NavNode[],
    /** A folder's twisty: whether it starts open, and what a click does. Null for a note. */
    twist: { open: boolean; toggle: () => boolean } | null,
  ): void {
    const row = container.createDiv({
      cls: `op-tree-row op-nav-row op-row-${node.isFolder ? 'folder' : 'file'}`,
      // Reachable by script but not by Tab: it is where focus lands when the
      // button a move came from has since been disabled. See `applyFocus`.
      attr: { tabindex: '-1' },
    })
    if (node.hidden) row.addClass('op-nav-hidden')
    this.focusables.set(focusKey(node.key, 'row'), row)

    const twisty = row.createSpan({ cls: 'op-twisty' })
    if (twist) {
      twisty.toggleClass('op-twisty-open', twist.open)
      setIcon(twisty, 'chevron-down')
      twisty.addEventListener('click', () => twisty.toggleClass('op-twisty-open', twist.toggle()))
    }

    setIcon(row.createSpan({ cls: 'op-tree-icon' }), node.isFolder ? 'folder' : 'file-text')
    row.createSpan({ cls: 'op-tree-name', text: node.label })

    for (const badge of badgesFor(node)) row.createSpan({ cls: 'op-badge', text: badge })
    const moves = this.moves(node, siblings)

    const controls = row.createDiv({ cls: 'op-nav-controls' })
    // Real buttons rather than styled spans, so Tab reaches them and Enter
    // presses them. A drag is exactly the kind of control only a mouse can
    // reach, and these are what a keyboard and a phone move a row with instead.
    const button = (name: NavControl, icon: string, label: string, enabled: boolean, run: () => void): void => {
      const element = controls.createEl('button', {
        cls: 'op-nav-button',
        attr: { type: 'button', 'aria-label': label },
      })
      setIcon(element, icon)
      if (enabled) element.addEventListener('click', run)
      else element.setAttr('disabled', 'true')
      this.focusables.set(focusKey(node.key, name), element)
    }

    button('up', 'chevron-up', `Move ${node.label} up`, moves.canMove && moves.up !== null, () =>
      this.move(node, siblings, -1),
    )
    button('down', 'chevron-down', `Move ${node.label} down`, moves.canMove && moves.down !== null, () =>
      this.move(node, siblings, 1),
    )
    // The icon names the action, matching the label beside it: an eye offers to
    // bring a hidden row back, a crossed-out one offers to take a row away.
    button(
      'hide',
      node.hidden ? 'eye' : 'eye-off',
      `${node.hidden ? 'Show' : 'Hide'} ${node.label} in navigation`,
      !node.hiddenByFrontmatter && node.paths.length > 0,
      () => this.toggleHidden(node),
    )

    if (moves.canMove) this.attachDrag(row, node, siblings)

    // No hover on a phone, and these controls are small. The hold opens the same
    // three actions as a menu, exactly as a folder rule's remove control does.
    // It is also what a phone has instead of the drag, which does not fire there
    // at all, and so is the path WCAG 2.2 SC 2.5.7 is actually about.
    if (Platform.isMobile) this.disposers.push(this.attachRowMenu(row, node, siblings, moves))
  }

  /**
   * Drag the whole row, and drop it onto the row whose place it should take.
   *
   * The whole row rather than a separate handle, because that is what Publish
   * does, `.op-tree-row` is already `user-select: none`, and a `<button>` inside
   * a draggable element still takes its own clicks.
   *
   * No geometry anywhere: nothing here measures a row or asks where in one the
   * pointer is. "Onto a row" means "take that row's slot", which reads correctly
   * in both directions and is exactly the splice `moveInto` already does. The
   * arrays answer which side of the target the line goes on, so nothing needs a
   * bounding box, and nothing needs a real browser to be tested.
   */
  private attachDrag(row: HTMLElement, node: NavNode, siblings: NavNode[]): void {
    row.setAttr('draggable', 'true')

    row.addEventListener('dragstart', () => {
      // No `dataTransfer` payload. A reorder inside one page transfers nothing:
      // it moves the element it started from, which is all that happens here.
      // MDN says as much, and it is also what leaves this drivable by a test.
      this.dragging = node
    })

    row.addEventListener('dragover', (event) => {
      if (!this.dragging || !this.canDrop(this.dragging, siblings, node)) return
      // A row becomes a drop target only by preventing the default, which is
      // "refuse". So a drop this dialog would not make never becomes one, and
      // no line is drawn over it.
      event.preventDefault()
      this.showDropLine(row, siblings.indexOf(this.dragging) < siblings.indexOf(node))
    })

    row.addEventListener('dragleave', () => {
      // Only if the line is still this row's: moving to the next row fires that
      // row's `dragover` before this `dragleave`, and clearing then would wipe
      // a marker that had just been drawn somewhere else.
      if (this.dropRow === row) this.clearDropLine()
    })

    row.addEventListener('drop', (event) => {
      const dragged = this.dragging
      this.dragging = null
      this.clearDropLine()
      if (!dragged || !this.canDrop(dragged, siblings, node)) return
      event.preventDefault()
      this.moveInto(dragged, siblings, node, 'row')
    })

    row.addEventListener('dragend', () => {
      this.dragging = null
      this.clearDropLine()
    })
  }

  /**
   * The insertion line, and only ever a line.
   *
   * A note and a folder can be siblings, so dropping a note onto a folder row is
   * a legal move that means "take that folder's place in the list". Highlighting
   * the folder would read as "put this note inside it", which this dialog can
   * never do: moving a note between folders would mean writing to the vault. A
   * line above or below a row says "insert here" and cannot be read as anything
   * else.
   */
  private showDropLine(row: HTMLElement, below: boolean): void {
    this.clearDropLine()
    row.addClass(below ? 'op-nav-drop-after' : 'op-nav-drop-before')
    this.dropRow = row
  }

  private clearDropLine(): void {
    this.dropRow?.removeClass('op-nav-drop-before', 'op-nav-drop-after')
    this.dropRow = null
  }

  /** Where this row could go, and whether anything here is allowed to move it. */
  private moves(node: NavNode, siblings: NavNode[]): NavMoves {
    const visible = siblings.filter((sibling) => this.showHidden || !sibling.hidden)
    const index = visible.indexOf(node)
    const neighbour = (candidate: NavNode | undefined): NavNode | null =>
      candidate && isMovable(candidate) ? candidate : null
    return {
      // A row frontmatter has placed, or one with no vault path to store,
      // cannot be arranged from here and must not pretend otherwise.
      canMove: isMovable(node),
      up: neighbour(visible[index - 1]),
      down: neighbour(visible[index + 1]),
    }
  }

  /** Is putting `node` in `target`'s slot a move this dialog is allowed to make? */
  private canDrop(node: NavNode, siblings: NavNode[], target: NavNode): boolean {
    return (
      node !== target &&
      // One parent, which is the whole limit: `siblings` is a single parent's
      // list, so a row dragged out of another folder is simply not in it.
      siblings.includes(node) &&
      siblings.includes(target) &&
      isMovable(node) &&
      isMovable(target)
    )
  }

  private move(node: NavNode, siblings: NavNode[], direction: -1 | 1): void {
    const moves = this.moves(node, siblings)
    const target = direction === -1 ? moves.up : moves.down
    if (target) this.moveInto(node, siblings, target, direction === -1 ? 'up' : 'down')
  }

  /**
   * Put a row in another row's slot, then write the whole sibling list down.
   *
   * One rule for the two buttons and for a drop in either direction. Taking both
   * indices before the splice is what makes it read correctly both ways with no
   * separate case for either: moving down lands the row after the target, moving
   * up lands it before.
   *
   *     [A,B,C] A onto C:  from=0 to=2 -> [B,C] -> insert at 2 -> [B,C,A]
   *     [A,B,C] C onto A:  from=2 to=0 -> [A,B] -> insert at 0 -> [C,A,B]
   *
   * The whole list rather than the pair, because "A is before B" is not enough
   * to reproduce an arrangement: the stored order has to name every sibling
   * whose place somebody has decided, or the next default sort would put the
   * two of them back where it likes among the rest.
   */
  private moveInto(node: NavNode, siblings: NavNode[], target: NavNode, from: NavControl): void {
    if (!this.canDrop(node, siblings, target)) return

    const arranged = [...siblings]
    arranged.splice(arranged.indexOf(node), 1)
    arranged.splice(siblings.indexOf(target), 0, node)

    const owned = new Set(siblings.flatMap((sibling) => sibling.paths))
    const kept = this.nav.order.filter((path) => !owned.has(path))
    const written = arranged.map((sibling) => sibling.paths[0]).filter((path): path is string => Boolean(path))
    this.nav.order = [...kept, ...written]
    this.restoreFocus = { key: node.key, control: from }
    this.moved = node
    this.apply()
  }

  private toggleHidden(node: NavNode): void {
    if (node.hiddenByFrontmatter || node.paths.length === 0) return
    const owned = new Set(node.paths)
    this.nav.hidden = node.hidden
      ? this.nav.hidden.filter((path) => !owned.has(path))
      : [...this.nav.hidden, node.paths[0]]
    this.restoreFocus = { key: node.key, control: 'hide' }
    this.apply()
  }

  /**
   * Put focus back where the press came from.
   *
   * `apply` rebuilds the tree, so the button that was just pressed no longer
   * exists and focus falls to the body: a keyboard user gets one Move down and
   * then has to Tab back from the top of the dialog. Node keys survive a render,
   * so finding the same control on the same row is a lookup rather than
   * bookkeeping.
   *
   * A row that has reached the end of its list leaves that button disabled, and
   * a disabled button cannot hold focus, so the row itself takes it: Tab carries
   * on from the row that moved, and nothing there acts on Enter.
   */
  private applyFocus(): void {
    const wanted = this.restoreFocus
    this.restoreFocus = null
    if (!wanted) return
    const control = this.focusables.get(focusKey(wanted.key, wanted.control))
    const target =
      control && !control.hasAttribute('disabled') ? control : this.focusables.get(focusKey(wanted.key, 'row'))
    target?.focus()
  }

  /**
   * Say what just happened, once.
   *
   * `aria-grabbed` and `aria-dropeffect` are deprecated and are not the answer;
   * a live region carrying the result of a completed move is. Polite rather than
   * assertive: assertive is for the running commentary during a drag, and each
   * of these is one finished, discrete action. It is also the only feedback a
   * drag gives a screen-reader user at all.
   */
  private announceMove(): void {
    const node = this.moved
    this.moved = null
    const place = node && this.places.get(node.key)
    if (node && place) this.liveEl?.setText(`${node.label} moved to ${place}`)
  }

  private attachRowMenu(row: HTMLElement, node: NavNode, siblings: NavNode[], moves: NavMoves): Disposer {
    return attachLongPress(row, {
      onLongPress: (point) => {
        const menu = new Menu()
        if (moves.canMove && moves.up) {
          menu.addItem((item) =>
            item.setTitle('Move up').setIcon('chevron-up').onClick(() => this.move(node, siblings, -1)),
          )
        }
        if (moves.canMove && moves.down) {
          menu.addItem((item) =>
            item.setTitle('Move down').setIcon('chevron-down').onClick(() => this.move(node, siblings, 1)),
          )
        }
        if (!node.hiddenByFrontmatter && node.paths.length > 0) {
          menu.addItem((item) =>
            item
              .setTitle(node.hidden ? 'Show in navigation' : 'Hide in navigation')
              .setIcon(node.hidden ? 'eye' : 'eye-off')
              .onClick(() => this.toggleHidden(node)),
          )
        }
        menu.showAtPosition({ x: point.x, y: point.y })
      },
    })
  }

  /**
   * The published notes, as much of each as this dialog needs.
   *
   * Notes only: an image never appears in a site's navigation, so listing every
   * published attachment here would offer a control that does nothing.
   *
   * Resolved from the selection rules rather than from a scan, because a scan
   * reads the bucket and this dialog must open instantly and offline. The one
   * difference that makes is a note pulled in only because something published
   * transcludes it, which the scan would include and this does not; it simply
   * does not appear as a row until it is published in its own right.
   */
  private publishedNotes(): NavNote[] {
    const resolver = resolverFromApp(this.app)
    const homepage = this.plugin.settings.site.homepage.trim()
    const notes: NavNote[] = []

    for (const file of this.app.vault.getMarkdownFiles()) {
      const path = file.path
      if (isAlwaysExcluded(path) || !this.plugin.isNotePublished(path)) continue
      const frontmatter = this.app.metadataCache.getCache(path)?.frontmatter
      const permalink = frontmatter?.['permalink']
      const slug =
        path === homepage
          ? 'index'
          : slugForPath(path, { permalink: typeof permalink === 'string' ? permalink : undefined })
      const order = readNavOrder(frontmatter?.['nav-order'])
      const hidden = readNavHidden(frontmatter?.['nav-hidden'])
      notes.push({
        path,
        slug,
        title: noteMetadata(resolver, path).title ?? path,
        ...(order !== undefined ? { order } : {}),
        ...(hidden !== undefined ? { hidden } : {}),
      })
    }
    return notes
  }
}

interface NavMoves {
  canMove: boolean
  up: NavNode | null
  down: NavNode | null
}

/** Can this dialog decide where this row goes, or has something else already? */
function isMovable(node: NavNode): boolean {
  return node.order === undefined && node.paths.length > 0
}

/** A slug can hold most things, but never a space, so a space separates the halves. */
const focusKey = (key: string, control: NavControl): string => `${key} ${control}`

/**
 * The right-hand labels, which exist to explain a disabled control rather than
 * to decorate a row. A row with no badge is one that behaves the obvious way.
 */
function badgesFor(node: NavNode): string[] {
  const badges: string[] = []
  // The homepage, which is a row here whatever its file is called and wherever
  // it sits. That matters most when it lives inside a folder: its row is drawn
  // at the root, because the site serves it at `/` and not at `/notes/home`.
  // This panel shows the site rather than the vault, and the badge is what makes
  // that read as an answer instead of a bug.
  if (node.key === 'index') badges.push('homepage')
  if (node.order !== undefined) badges.push(`nav-order: ${node.order}`)
  if (node.hiddenByFrontmatter) badges.push(node.hidden ? 'nav-hidden' : 'nav-hidden: false')
  else if (node.hidden) badges.push('hidden')
  // A folder that exists on the site and nowhere in the vault: every note in it
  // arrived by `permalink`, so there is no path to store a decision against and
  // its controls are off.
  if (node.order === undefined && node.paths.length === 0) badges.push('not a vault folder')
  return badges
}
