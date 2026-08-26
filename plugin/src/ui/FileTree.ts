/**
 * Vault paths as a folder tree, plus the tick arithmetic that goes with one.
 *
 * A flat list of paths is unreadable past about a dozen files, and every vault
 * that is worth publishing has more than that. Obsidian Publish shows a tree;
 * so do we, and for the same reason: people recognise their own folders faster
 * than they read their own filenames.
 *
 * Pure data (no DOM, no Obsidian), so the shape and the tick rules are unit
 * tested under plain Node. Rendering lives in PublishModal.
 */

export interface TreeFile {
  kind: 'file'
  /** Basename, which is what gets shown. */
  name: string
  /** Full vault path, which is what gets ticked. */
  path: string
}

export interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: TreeNode[]
  /** Every file path below this folder, at any depth. Cached: ticks read it constantly. */
  files: string[]
}

export type TreeNode = TreeFile | TreeFolder

/** A parent whose children disagree. Rendered as a dash rather than a tick. */
export type TickState = 'on' | 'off' | 'partial'

/**
 * Build the tree.
 *
 * Folders sort before files and both sort naturally, so "10-" lands after "9-"
 * the way a person expects rather than the way ASCII expects.
 */
export function buildTree(paths: Iterable<string>): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [], files: [] }
  const folders = new Map<string, TreeFolder>([['', root]])
  const seen = new Set<string>()

  for (const path of paths) {
    if (seen.has(path)) continue
    seen.add(path)

    const segments = path.split('/').filter((segment) => segment.length > 0)
    const name = segments.pop()
    if (name === undefined) continue

    let parent = root
    let prefix = ''
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let folder = folders.get(prefix)
      if (!folder) {
        folder = { kind: 'folder', name: segment, path: prefix, children: [], files: [] }
        folders.set(prefix, folder)
        parent.children.push(folder)
      }
      parent = folder
    }
    parent.children.push({ kind: 'file', name, path })
  }

  finish(root)
  return root.children
}

/** Sort in place, depth first, and fill in each folder's cached file list. */
function finish(folder: TreeFolder): string[] {
  folder.children.sort(compareNodes)
  folder.files = []
  for (const child of folder.children) {
    if (child.kind === 'folder') folder.files.push(...finish(child))
    else folder.files.push(child.path)
  }
  return folder.files
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || (a.name < b.name ? -1 : 1)
}

/** Every file path under a node, in display order. */
export function filesUnder(node: TreeNode): string[] {
  return node.kind === 'file' ? [node.path] : node.files
}

export function allFiles(nodes: TreeNode[]): string[] {
  return nodes.flatMap(filesUnder)
}

/**
 * A folder is ticked when all of its files are, part-ticked when only some are.
 *
 * An empty folder reads as `off`: there is nothing in it to publish, so nothing
 * about it is selected.
 */
export function tickState(node: TreeNode, selected: ReadonlySet<string>): TickState {
  if (node.kind === 'file') return selected.has(node.path) ? 'on' : 'off'
  let ticked = 0
  for (const path of node.files) {
    if (selected.has(path)) ticked++
  }
  if (ticked === 0) return 'off'
  return ticked === node.files.length ? 'on' : 'partial'
}

/**
 * Ticking a folder ticks everything under it; unticking clears everything.
 *
 * A part-ticked folder ticks the rest rather than clearing: the click is
 * almost always "I want this folder", not "undo what I already chose".
 */
export function toggleNode(node: TreeNode, selected: Set<string>): void {
  const paths = filesUnder(node)
  const turnOn = tickState(node, selected) !== 'on'
  for (const path of paths) {
    if (turnOn) selected.add(path)
    else selected.delete(path)
  }
}

export function countSelected(paths: Iterable<string>, selected: ReadonlySet<string>): number {
  let count = 0
  for (const path of paths) {
    if (selected.has(path)) count++
  }
  return count
}
