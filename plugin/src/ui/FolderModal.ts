/**
 * The manage-folders dialog.
 *
 * Both lists live in one window because excludes are checked before includes
 * (`selection.ts`), so a folder that is not publishing is very often explained
 * by the *other* list. Two dialogs would hide exactly the relationship someone
 * opens this to understand.
 *
 * The number beside each rule is the reason this beats a text box: it says what
 * the rule is doing right now, so a renamed folder and a shadowed include are
 * both visible here rather than as a surprise inside the publish window later.
 * It is recomputed when the dialog opens and after each add or remove: a walk
 * of the file list per rule, which is a few milliseconds on a large vault, and
 * never per keystroke, which it could not be.
 */

import { Modal, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { addRule, folderRulesSentence, removeRule, summarizeRules } from './FolderRules.ts'
import type { RuleSummary } from './FolderRules.ts'
import { renderFolderList } from './RuleList.ts'
import type { Disposer } from './RuleList.ts'
import { renderPublishImportRow } from './PublishImportModal.ts'

export class FolderModal extends Modal {
  private disposers: Disposer[] = []
  private readonly plugin: OpenPublishPlugin
  /** Lets the settings tab refresh its summary row, and revalidate the homepage. */
  private readonly onDone: () => void

  // Written out rather than as constructor parameter properties: Node's
  // type-stripping cannot erase those, and the test suite runs this file.
  constructor(app: App, plugin: OpenPublishPlugin, onDone: () => void = () => {}) {
    super(app)
    this.plugin = plugin
    this.onDone = onDone
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.setTitle('Manage published folders')
    this.render()
  }

  override onClose(): void {
    this.dispose()
    this.contentEl.empty()
    this.onDone()
  }

  private dispose(): void {
    for (const disposer of this.disposers) disposer()
    this.disposers = []
  }

  private summarize(): RuleSummary {
    const selection = this.plugin.settings.selection
    return summarizeRules({
      files: this.app.vault.getFiles().map((file) => file.path),
      includes: selection.includes,
      excludes: selection.excludes,
      folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
    })
  }

  private render(): void {
    this.dispose()
    const { contentEl } = this
    contentEl.empty()

    const selection = this.plugin.settings.selection
    const summary = this.summarize()

    contentEl.createEl('p', { cls: 'op-rule-intro', text: folderRulesSentence(summary) })

    // Above both lists, and only for a vault that has a `publish.json`: this is
    // the screen somebody arriving from Obsidian Publish would otherwise retype
    // eight folder names into.
    renderPublishImportRow({ app: this.app, container: contentEl, plugin: this.plugin, onDone: () => this.render() })

    // A folder in one list must not be offered by the other's picker: it would
    // end up in both, where the exclude would silently win.
    const taken = (): string[] => [...selection.includes, ...selection.excludes]

    new Setting(contentEl).setName('Included').setHeading()
    this.disposers.push(
      renderFolderList({
        app: this.app,
        container: contentEl,
        stats: summary.includes,
        taken,
        placeholder: 'Add a folder…',
        emptyText: 'No folders yet. Notes with publish: true in their frontmatter still publish.',
        onAdd: (rule) => this.update(() => (selection.includes = addRule(selection.includes, rule))),
        onRemove: (rule) => this.update(() => (selection.includes = removeRule(selection.includes, rule))),
      }),
    )

    new Setting(contentEl).setName('Excluded').setHeading()
    this.disposers.push(
      renderFolderList({
        app: this.app,
        container: contentEl,
        stats: summary.excludes,
        taken,
        placeholder: 'Add a folder…',
        emptyText: 'Nothing is being held back.',
        onAdd: (rule) => this.update(() => (selection.excludes = addRule(selection.excludes, rule))),
        onRemove: (rule) => this.update(() => (selection.excludes = removeRule(selection.excludes, rule))),
      }),
    )

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Done')
        .setCta()
        .onClick(() => this.close()),
    )
  }

  /**
   * Every edit takes effect at once; Done only closes. Nothing here is a draft.
   *
   * The redraw does not wait on the write: it reads the settings object, which
   * is already correct, and making the list lag a disk round-trip would show a
   * stale count for no gain.
   */
  private update(change: () => void): void {
    change()
    this.render()
    void this.plugin.saveSettings()
  }
}
