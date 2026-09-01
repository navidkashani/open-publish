/**
 * The one picker behind three wizard steps and the rollback dialog.
 *
 * Two things are worth pinning here rather than through any one caller. The
 * mark, because "which row is chosen" was previously carried by a background
 * tint and one accent-coloured word, and neither survives a screenshot. And the
 * placement of the detail panel: it is a *sibling* of the selected row inside
 * the list, because the row is a `<button>` and a link nested in a button is
 * invalid markup that swallows the link.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderPickerList } from '../src/ui/PickerList.ts'
import { byClass, click, el, find, findAll } from './dom.mjs'

const ROWS = [
  { id: 'first', name: 'First', summary: 'One line about the first.' },
  { id: 'second', name: 'Second', summary: 'One line about the second.', caution: 'Costs something.' },
  { id: 'third', name: 'Third', summary: 'One line about the third.' },
]

const rows = (root) => findAll(root, byClass('op-provider-row'))
const rowNamed = (root, name) =>
  rows(root).find((row) => find(row, byClass('op-provider-name'))?.textContent === name)

function render(selected, renderDetail) {
  const root = el()
  const picked = []
  renderPickerList(root, ROWS, selected, (id) => picked.push(id), renderDetail)
  return { root, picked, list: find(root, byClass('op-provider-list')) }
}

test('every row draws a mark, so the chosen one is legible without reading colour', () => {
  const { root } = render('second')
  for (const row of rows(root)) {
    assert.ok(find(row, byClass('op-picker-mark')), `${find(row, byClass('op-provider-name')).textContent} has no mark`)
  }
})

test('exactly one row is selected, and the pressed state agrees with it', () => {
  const { root } = render('second')
  const selected = rows(root).filter((row) => row.hasClass('is-selected'))
  assert.equal(selected.length, 1, 'two marked rows are not a choice')
  assert.equal(find(selected[0], byClass('op-provider-name')).textContent, 'Second')

  // The mark is drawn from the class; `aria-pressed` is what is announced.
  // They have to say the same thing or one of them is lying.
  for (const row of rows(root)) {
    assert.equal(row.getAttr('aria-pressed'), String(row.hasClass('is-selected')))
  }
})

test('the panel is drawn once, inside the list, immediately after the row it belongs to', () => {
  const { list } = render('second', (panel) => panel.createEl('a', { href: '#', text: 'A link' }))

  const panels = findAll(list, byClass('op-picker-detail'))
  assert.equal(panels.length, 1, 'the guidance belongs to one option, so it is drawn once')

  const order = list.children
  const selectedIndex = order.findIndex((node) => node.hasClass('is-selected'))
  assert.equal(order[selectedIndex + 1], panels[0], 'the panel has to sit under the row it explains')

  // Not nested in the button: a `<button>` containing an anchor is invalid, and
  // the button swallows the click the anchor exists for.
  assert.equal(panels[0].parentElement, list)
  assert.equal(find(order[selectedIndex], (node) => node.tagName === 'A'), null)
})

test('picking another option moves the mark and the panel together', () => {
  // The whole mechanism the component exists for. Before the panel it was
  // invisible: switching rows silently swapped a block of text elsewhere.
  let selected = 'first'
  const root = el()
  const draw = () => {
    root.empty()
    renderPickerList(
      root,
      ROWS,
      selected,
      (id) => {
        selected = id
        draw()
      },
      (panel) => panel.createDiv({ text: `Steps for ${selected}` }),
    )
  }
  draw()

  assert.match(find(root, byClass('op-picker-detail')).textContent, /Steps for first/)

  click(rowNamed(root, 'Third'))

  assert.equal(selected, 'third')
  const list = find(root, byClass('op-provider-list'))
  const panel = find(list, byClass('op-picker-detail'))
  assert.match(panel.textContent, /Steps for third/)
  assert.equal(list.children[list.children.indexOf(panel) - 1], rowNamed(root, 'Third'))
  assert.equal(rowNamed(root, 'First').hasClass('is-selected'), false)
})

test('a list with no callback renders no panel, which is the rollback dialog', () => {
  // Site history selects nothing and explains nothing per row: every version
  // says all it has to say in its own summary.
  const { root } = render('')
  assert.equal(find(root, byClass('op-picker-detail')), null)
  assert.equal(rows(root).filter((row) => row.hasClass('is-selected')).length, 0)
})

test('a callback with nothing selected still draws no panel', () => {
  const { root } = render('', (panel) => panel.createDiv({ text: 'unreachable' }))
  assert.equal(find(root, byClass('op-picker-detail')), null)
})

test('the row body keeps carrying the name, the summary and the caution', () => {
  // The mark made the row a two-column grid, and the text moved into the second
  // column. Every caller finds these by class, so the wrapper has to be the
  // only thing that changed.
  const { root } = render('second')
  const row = rowNamed(root, 'Second')
  const body = find(row, byClass('op-picker-body'))
  assert.ok(body)
  assert.equal(find(body, byClass('op-provider-name')).textContent, 'Second')
  assert.equal(find(body, byClass('op-provider-summary')).textContent, 'One line about the second.')
  assert.equal(find(body, byClass('op-provider-caution-line')).textContent, 'Costs something.')
})
