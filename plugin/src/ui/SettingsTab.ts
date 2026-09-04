/**
 * The settings tab: a shell around `settingDefinitions`.
 *
 * Everything that decides what the screen says lives in that module, which
 * imports Obsidian for types only and so can be asserted as plain data. What
 * is left here is the part that genuinely needs the app: the dialogs, the note
 * suggester, the two imperative forms, and the storage the declarative
 * controls read and write through.
 */

import { Notice, PluginSettingTab } from 'obsidian'
import type { App, SettingDefinitionItem } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { hasHostMoved, hasStorageMoved, storageMovedWarning } from '../settings.ts'
import { parsePublishFrontmatter } from '../core/selection.ts'
import { FolderModal } from './FolderModal.ts'
import { NavigationModal, navSizeWarning } from './NavigationModal.ts'
import { RollbackModal } from './RollbackModal.ts'
import { PathSuggest, normalizeTypedPath } from './PathSuggest.ts'
import { BuildFields } from './BuildFields.ts'
import { FieldsPage } from './FieldsPage.ts'
import { SetupWizard } from './SetupWizard.ts'
import { StorageFields } from './StorageFields.ts'
import { RERENDER_KEYS, readSetting, settingDefinitions, writeSetting } from './settingDefinitions.ts'

export class OpenPublishSettingTab extends PluginSettingTab {
  private readonly plugin: OpenPublishPlugin

  constructor(app: App, plugin: OpenPublishPlugin) {
    super(app, plugin)
    this.plugin = plugin
    // Set, but do not expect to see it. `SettingTab.icon` is real API (1.11.0)
    // and Obsidian does build the element (`addSettingTab` runs
    // `icon && createDiv("vertical-tab-nav-item-icon", …)`), but the app's own
    // stylesheet then hides it for our entire group:
    //
    //   .vertical-tab-header-group-items[data-section="community-plugins"]
    //     .vertical-tab-nav-item-icon { display: none }
    //
    // which is why no community plugin shows one. Checked against 1.13.7. It
    // stays because it is the correct call and costs nothing if that rule ever
    // goes; forcing it with our own CSS would override the host app to make
    // this plugin the only odd row in the list.
    //
    // The Community Plugins *list* entry is a separate question with a flat no:
    // `PluginManifest` has no icon field. Assigned in the constructor rather
    // than declared as a field so `noImplicitOverride` does not ask for an
    // `override` keyword on a base-class property.
    this.icon = 'upload-cloud'
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const plugin = this.plugin
    return settingDefinitions({
      settings: plugin.settings,
      save: () => plugin.saveSettings(),
      update: () => this.update(),

      storagePage: () => new FieldsPage('Storage', (host) => this.renderStorage(host)),
      buildPage: () => new FieldsPage('Site build', (host) => this.renderBuild(host)),

      openSetup: () => new SetupWizard(this.app, plugin).open(),
      openFolders: () => new FolderModal(this.app, plugin, () => this.update()).open(),
      openNavigation: () => new NavigationModal(this.app, plugin, () => this.update()).open(),
      openRollback: () => new RollbackModal(this.app, plugin, () => this.update()).open(),

      filePaths: () => this.app.vault.getFiles().map((file) => file.path),
      markdownPaths: () => this.app.vault.getMarkdownFiles().map((file) => file.path),
      folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
      // Exact and immediate, without walking the vault.
      fileExists: (path) => this.app.vault.getFileByPath(path) !== null,
      isNotePublished: (path) => plugin.isNotePublished(path),
      frontmatterPublish: (path) =>
        parsePublishFrontmatter(this.app.metadataCache.getCache(path)?.frontmatter?.['publish']),

      attachPathSuggest: (input, options) => {
        new PathSuggest(this.app, input, options)
      },
      normalizeTypedPath,
      navSizeWarning,

      runSelfTest: () => plugin.runStorageSelfTest(),
      runCleanup: () => plugin.runGarbageCollection(),
      clearHashCache: () => plugin.clearHashCache(),
      notify: (message) => {
        new Notice(message)
      },
    })
  }

  /**
   * Four fields and a provider, with the endpoint built for you.
   *
   * It used to be seven, endpoint typed by hand, and the first entry in
   * troubleshooting.md was a malformed one. The form itself lives in
   * `StorageFields`, shared with the setup wizard, which was already a
   * near-duplicate of this before a catalogue doubled the branching in both.
   *
   * No `onProviderChange`, unlike the flat screen this replaced. Copy outside
   * the form still depends on the provider (the cleanup row on the Maintenance
   * page carries this provider's caution), but that copy is now on another
   * page, and the definitions are rebuilt on every render of the tab. So the
   * form repaints itself and nothing is stale by the time it is read.
   */
  private renderStorage(host: HTMLElement): void {
    // A dropdown here, a row list in the wizard. Settings is a maintenance
    // surface where the choice has already been made, and the analytics
    // provider on the site page sets exactly this precedent.
    new StorageFields(host, {
      app: this.app,
      destination: () => this.plugin.settings.destination,
      replaceDestination: (next) => {
        this.plugin.settings.destination = next
      },
      save: () => this.plugin.saveSettings(),
      showProviderPicker: true,
      test: () => this.plugin.testDestination(),
      storageMoved: () =>
        hasStorageMoved(this.plugin.settings) ? storageMovedWarning(this.plugin.settings) : null,
    }).render()
  }

  /**
   * Six rows and a host, with the free plan quoted from the host you actually
   * use.
   *
   * The form lives in `BuildFields`, shared with step 5 of the setup wizard,
   * which was a near-duplicate of this in the same way the storage form used to
   * be. What it replaced was worse than duplication: this section told every
   * user, on every host, that "Cloudflare Pages' free plan allows 500 builds a
   * month", which on Netlify is wrong by more than an order of magnitude in the
   * direction that costs them the month.
   */
  private renderBuild(host: HTMLElement): void {
    new BuildFields(host, {
      builder: this.plugin.settings.builder,
      save: () => this.plugin.saveSettings(),
      showHostPicker: true,
      test: () => this.plugin.testBuilder(),
      hostMoved: () => hasHostMoved(this.plugin.settings),
    }).render()
  }

  override getControlValue(key: string): unknown {
    return readSetting(this.plugin.settings, key)
  }

  override setControlValue(key: string, value: unknown): Promise<void> {
    writeSetting(this.plugin.settings, key, value)
    // Only for the keys some other row's *description* is built from: a
    // description cannot be a function, so refreshing DOM state is not enough.
    if (RERENDER_KEYS.has(key)) this.update()
    return this.plugin.saveSettings()
  }
}
