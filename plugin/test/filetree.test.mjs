import test from 'node:test'
import assert from 'node:assert/strict'
import { allFiles, buildTree, countSelected, filesUnder, tickState, toggleNode } from '../src/ui/FileTree.ts'

const names = (nodes) => nodes.map((node) => (node.kind === 'folder' ? `${node.name}/` : node.name))

test('a flat list becomes a folder tree', () => {
  const tree = buildTree(['Notes/a.md', 'Notes/b.md', 'top.md'])
  assert.deepEqual(names(tree), ['Notes/', 'top.md'])
  assert.deepEqual(names(tree[0].children), ['a.md', 'b.md'])
  assert.equal(tree[0].path, 'Notes')
  assert.equal(tree[0].children[0].path, 'Notes/a.md')
})

test('a folder chain is built once, however many files sit at the bottom', () => {
  const tree = buildTree(['A/B/C/one.md', 'A/B/C/two.md', 'A/B/other.md'])
  assert.deepEqual(names(tree), ['A/'])
  const b = tree[0].children[0]
  assert.equal(b.path, 'A/B')
  assert.deepEqual(names(b.children), ['C/', 'other.md'])
  assert.deepEqual(names(b.children[0].children), ['one.md', 'two.md'])
})

test('folders sort before files, and both sort the way a person reads numbers', () => {
  const tree = buildTree(['zeta.md', 'Alpha/x.md', '10-later.md', '9-earlier.md'])
  assert.deepEqual(names(tree), ['Alpha/', '9-earlier.md', '10-later.md', 'zeta.md'])
})

test('spaces and non-Latin names survive intact and still sort', () => {
  const paths = ['Wisdom & Approaches/How to Get Rich/20- Take Accountability.md', 'ノート/読書.md', 'Ünicode/éclair.md']
  const tree = buildTree(paths)
  assert.deepEqual(names(tree), ['Ünicode/', 'Wisdom & Approaches/', 'ノート/'])
  const rich = tree[1].children[0]
  assert.equal(rich.name, 'How to Get Rich')
  assert.equal(rich.children[0].name, '20- Take Accountability.md')
  assert.deepEqual(allFiles(tree).sort(), [...paths].sort())
})

test('a duplicate path appears once', () => {
  const tree = buildTree(['a.md', 'a.md'])
  assert.equal(allFiles(tree).length, 1)
})

test('every folder knows every file beneath it, at any depth', () => {
  const tree = buildTree(['A/B/one.md', 'A/two.md'])
  assert.deepEqual(filesUnder(tree[0]).sort(), ['A/B/one.md', 'A/two.md'])
  assert.deepEqual(filesUnder(tree[0].children[0]), ['A/B/one.md'])
})

test('ticking a folder ticks everything under it', () => {
  const tree = buildTree(['A/B/one.md', 'A/two.md', 'other.md'])
  const selected = new Set()
  toggleNode(tree[0], selected)
  assert.deepEqual([...selected].sort(), ['A/B/one.md', 'A/two.md'])
  assert.equal(selected.has('other.md'), false, 'and nothing outside it')
})

test('unticking a ticked folder clears everything under it', () => {
  const tree = buildTree(['A/one.md', 'A/two.md'])
  const selected = new Set(['A/one.md', 'A/two.md'])
  toggleNode(tree[0], selected)
  assert.equal(selected.size, 0)
})

test('a parent whose children disagree shows part-ticked', () => {
  const tree = buildTree(['A/one.md', 'A/two.md'])
  const selected = new Set(['A/one.md'])
  assert.equal(tickState(tree[0], selected), 'partial')
  selected.add('A/two.md')
  assert.equal(tickState(tree[0], selected), 'on')
  selected.clear()
  assert.equal(tickState(tree[0], selected), 'off')
})

test('a part-ticked folder ticks the rest rather than clearing what is already chosen', () => {
  const tree = buildTree(['A/one.md', 'A/two.md'])
  const selected = new Set(['A/one.md'])
  toggleNode(tree[0], selected)
  assert.deepEqual([...selected].sort(), ['A/one.md', 'A/two.md'])
})

test('part-ticked propagates all the way up a chain', () => {
  const tree = buildTree(['A/B/C/deep.md', 'A/shallow.md'])
  const selected = new Set(['A/B/C/deep.md'])
  const a = tree[0]
  const b = a.children[0]
  const c = b.children[0]
  assert.equal(tickState(c, selected), 'on', 'the folder that actually holds it is full')
  assert.equal(tickState(b, selected), 'on')
  assert.equal(tickState(a, selected), 'partial', 'its parent still has an unticked sibling')
})

test('an empty folder reads as off, never as fully ticked', () => {
  const empty = { kind: 'folder', name: 'Empty', path: 'Empty', children: [], files: [] }
  assert.equal(tickState(empty, new Set()), 'off')
})

test('All and None cover exactly the section, counted against the section', () => {
  const paths = ['A/one.md', 'A/two.md', 'b.md']
  const selected = new Set(['unrelated.md'])
  for (const path of paths) selected.add(path)
  assert.equal(countSelected(paths, selected), 3)
  for (const path of paths) selected.delete(path)
  assert.equal(countSelected(paths, selected), 0)
  assert.equal(selected.has('unrelated.md'), true, 'another section is untouched')
})

test('a file ticks by itself without disturbing its siblings', () => {
  const tree = buildTree(['A/one.md', 'A/two.md'])
  const selected = new Set()
  toggleNode(tree[0].children[0], selected)
  assert.deepEqual([...selected], ['A/one.md'])
})
