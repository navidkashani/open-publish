import { Notice, PluginSettingTab, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { hasHostMoved, hasStorageMoved, storageMovedWarning } from '../settings.ts'
import { providerById } from '../destinations/providers.ts'
import { isAlwaysExcluded, parsePublishFrontmatter } from '../core/selection.ts'
import { FolderModal } from './FolderModal.ts'
import { folderRulesSummary, summarizeRules } from './FolderRules.ts'
import { PathSuggest, normalizeTypedPath } from './PathSuggest.ts'
import { renderRuleRows } from './RuleList.ts'
import type { Disposer } from './RuleList.ts'
import { BuildFields } from './BuildFields.ts'
import { SetupWizard } from './SetupWizard.ts'
import { StorageFields } from './StorageFields.ts'

const HOMEPAGE_DESC = 'The note visitors land on, e.g. "Notes/Home.md". It has to be a published note.'

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

  /** Long-press listeners on rows that a re-render is about to throw away. */
  private disposeRows: Disposer = () => {}

  override display(): void {
    const { containerEl } = this
    this.disposeRows()
    this.disposeRows = () => {}
    containerEl.empty()

    new Setting(containerEl)
      .setName('Setup')
      .setDesc('Walks you through storage, the site repository, hosting and the deploy hook, testing each step.')
      .addButton((button) =>
        button
          .setButtonText('Open setup guide')
          .setCta()
          .onClick(() => new SetupWizard(this.app, this.plugin).open()),
      )

    this.renderStorage(containerEl)
    this.renderBuild(containerEl)
    this.renderSelection(containerEl)
    this.renderSite(containerEl)
    this.renderMaintenance(containerEl)
    this.renderSecurityNote(containerEl)
  }

  /**
   * Four fields and a provider, with the endpoint built for you.
   *
   * It used to be seven, endpoint typed by hand, and the first entry in
   * troubleshooting.md was a malformed one. The form itself lives in
   * `StorageFields`, shared with the setup wizard, which was already a
   * near-duplicate of this before a catalogue doubled the branching in both.
   */
  private renderStorage(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Storage').setHeading()

    // A dropdown here, a row list in the wizard. Settings is a maintenance
    // surface where the choice has already been made, and the analytics
    // provider two sections down sets exactly this precedent.
    const fields = new StorageFields(containerEl, {
      destination: () => this.plugin.settings.destination,
      replaceDestination: (next) => {
        this.plugin.settings.destination = next
      },
      save: () => this.plugin.saveSettings(),
      showProviderPicker: true,
      test: () => this.plugin.testDestination(),
      storageMoved: () =>
        hasStorageMoved(this.plugin.settings) ? storageMovedWarning(this.plugin.settings) : null,
      // The whole tab, not just the form: the cleanup row below carries this
      // provider's caution, and a screen that updates half of itself is worse
      // than one that takes a moment.
      onProviderChange: () => this.display(),
    })
    fields.render()
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
  private renderBuild(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Site build').setHeading()

    // No `onHostChange` here, unlike storage: nothing outside this form depends
    // on the host, so the form can repaint itself.
    const fields = new BuildFields(containerEl, {
      builder: this.plugin.settings.builder,
      save: () => this.plugin.saveSettings(),
      showHostPicker: true,
      test: () => this.plugin.testBuilder(),
      hostMoved: () => hasHostMoved(this.plugin.settings),
    })
    fields.render()
  }

  private renderSelection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('What gets published').setHeading()
    const selection = this.plugin.settings.selection

    // One row rather than two textareas. The counts are the point: a folder
    // rule is worth showing as what it currently matches, not as text.
    const summary = summarizeRules({
      files: this.app.vault.getFiles().map((file) => file.path),
      includes: selection.includes,
      excludes: selection.excludes,
      folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
    })

    new Setting(containerEl)
      .setName('Folders')
      .setDesc(folderRulesSummary(summary))
      .addButton((button) =>
        button
          .setButtonText('Manage folders…')
          // Reopening settings is what refreshes the counts and revalidates the
          // homepage, which a rule change can invalidate.
          .onClick(() => new FolderModal(this.app, this.plugin, () => this.display()).open()),
      )

    new Setting(containerEl)
      .setName('Include embedded attachments automatically')
      .setDesc(
        'Publishes any image or file that a published note embeds, wherever it lives in your vault. ' +
          'Turning this off is the usual cause of a site with broken images.',
      )
      .addToggle((toggle) =>
        toggle.setValue(selection.autoIncludeEmbeds).onChange(async (value) => {
          selection.autoIncludeEmbeds = value
          await this.plugin.saveSettings()
        }),
      )

    this.renderOverrides(containerEl)
  }

  /**
   * The per-file choices, as a list rather than a count.
   *
   * These are written by the file context menu and by "Add linked" in the
   * publish window, so they accumulate without anyone deciding to keep a list.
   * That is what makes "3 files" the least useful thing to say about them.
   */
  private renderOverrides(containerEl: HTMLElement): void {
    const selection = this.plugin.settings.selection
    const paths = Object.keys(selection.explicit).sort()
    if (paths.length === 0) return

    new Setting(containerEl)
      .setName('Per-file choices')
      .setDesc(`${paths.length} ${paths.length === 1 ? 'file' : 'files'} individually included or excluded.`)

    const list = containerEl.createDiv({ cls: 'op-rule-list' })
    this.disposeRows = renderRuleRows(
      list,
      paths.map((path) => ({
        path,
        icon: 'file-text',
        meta: selection.explicit[path] ? 'published' : 'excluded',
        // Frontmatter outranks the stored preference, so a note that pins its
        // own state makes this row inert. Better to say so than to leave
        // someone wondering why the choice does nothing.
        warning: this.frontmatterOverride(path),
        onRemove: () => {
          delete selection.explicit[path]
          this.display()
          void this.plugin.saveSettings()
        },
      })),
      '',
    )

    new Setting(containerEl).addButton((button) =>
      button
        .setButtonText('Clear all')
        .setDestructive()
        .onClick(() => {
          selection.explicit = {}
          this.display()
          void this.plugin.saveSettings()
        }),
    )
  }

  /**
   * The homepage, as a note picker with the check done here rather than later.
   *
   * All three failure states used to surface at scan time, as a warning inside
   * the publish window, which is the wrong place and the wrong moment for
   * something you can only fix in settings. `getFileByPath` makes the existence
   * check exact and immediate without walking the vault.
   */
  private renderHomepage(containerEl: HTMLElement): void {
    const site = this.plugin.settings.site
    const setting = new Setting(containerEl).setName('Homepage')

    const validate = (): void => {
      const path = site.homepage
      if (!path) {
        setting.setDesc('A simple index page will be generated.')
        setting.setErrorMessage(null)
        return
      }
      setting.setDesc(HOMEPAGE_DESC)
      if (!this.app.vault.getFileByPath(path)) {
        setting.setErrorMessage('This note no longer exists.')
        return
      }
      setting.setErrorMessage(
        this.plugin.isNotePublished(path)
          ? null
          : "This note isn't being published, so the site will use a generated index page instead.",
      )
    }

    setting.addSearch((search) => {
      search.setPlaceholder('Notes/Home.md').setValue(site.homepage)

      const apply = async (value: string): Promise<void> => {
        site.homepage = normalizeTypedPath(value)
        await this.plugin.saveSettings()
        validate()
      }

      new PathSuggest(this.app, search.inputEl, {
        items: () =>
          this.app.vault
            .getMarkdownFiles()
            .map((file) => file.path)
            .filter((path) => !isAlwaysExcluded(path)),
        onPick: (path) => void apply(path),
      })

      search.onChange((value) => void apply(value))
    })

    validate()
  }

  private frontmatterOverride(path: string): string | null {
    const pinned = parsePublishFrontmatter(this.app.metadataCache.getCache(path)?.frontmatter?.['publish'])
    if (pinned === null) return null
    return `This note sets publish: ${pinned} in its frontmatter, which wins. This choice has no effect.`
  }

  private renderSite(containerEl: HTMLElement): void {
    const site = this.plugin.settings.site

    new Setting(containerEl).setName('Site options').setHeading()

    new Setting(containerEl)
      .setName('Site name')
      .setDesc('Shown in the page title and in the site header.')
      .addText((text) =>
        text.setValue(site.title).onChange(async (value) => {
          site.title = value
          await this.plugin.saveSettings()
        }),
      )

    this.renderHomepage(containerEl)

    new Setting(containerEl)
      .setName('Discourage search engines')
      .setDesc(
        'Asks search engines not to list your site. ' +
          'It is a request, not a lock: anyone with the address can still read everything.',
      )
      .addToggle((toggle) =>
        toggle.setValue(site.noIndex).onChange(async (value) => {
          site.noIndex = value
          await this.plugin.saveSettings()
        }),
      )

    // One heading for the eight toggles that all answer "what does a page look
    // like". Three headings for eight toggles, two of them governing a single
    // toggle each, was a table of contents for a list.
    new Setting(containerEl).setName('Appearance').setHeading()

    new Setting(containerEl)
      .setName('Light/dark toggle')
      .setDesc('Let visitors switch theme. The site follows their system setting either way.')
      .addToggle((toggle) =>
        toggle.setValue(site.showThemeToggle).onChange(async (value) => {
          site.showThemeToggle = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Strict line breaks')
      .setDesc(
        'Markdown ignores single line breaks. Leave this off and they show up as you wrote them, ' +
          'which is usually what you want for notes.',
      )
      .addToggle((toggle) =>
        toggle.setValue(site.strictLineBreaks).onChange(async (value) => {
          site.strictLineBreaks = value
          await this.plugin.saveSettings()
        }),
      )

    const toggles: Array<['showNavigation' | 'showSearch' | 'showGraph' | 'showOutline' | 'showBacklinks' | 'showTags', string, string]> = [
      ['showNavigation', 'Navigation', 'A list of published pages alongside the content.'],
      ['showSearch', 'Search', 'Search across page titles, headings and content.'],
      ['showGraph', 'Graph view', 'A small local graph on each page.'],
      ['showOutline', 'Table of contents', 'The outline of headings on each page.'],
      ['showBacklinks', 'Backlinks', 'Which published pages link to this one.'],
      ['showTags', 'Tags', 'Show a page\'s tags, and give each tag its own page.'],
    ]
    for (const [key, label, description] of toggles) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(description)
        .addToggle((toggle) =>
          toggle.setValue(site[key]).onChange(async (value) => {
            site[key] = value
            await this.plugin.saveSettings()
          }),
        )
    }

    new Setting(containerEl).setName('Analytics').setHeading()

    const analyticsId = new Setting(containerEl)
      .setName('Tracking ID')
      .addText((text) =>
        text.setValue(site.analytics.id).onChange(async (value) => {
          site.analytics.id = value.trim()
          await this.plugin.saveSettings()
        }),
      )

    const describeAnalytics = () => {
      const hints: Record<string, string> = {
        none: 'No analytics are added to your site.',
        google: 'Your Google Analytics measurement ID, e.g. G-XXXXXXXXXX.',
        plausible: 'Your Plausible domain, e.g. notes.example.com.',
        umami: 'Your Umami website ID.',
      }
      analyticsId.setDesc(hints[site.analytics.provider] ?? '')
      analyticsId.settingEl.toggle(site.analytics.provider !== 'none')
    }

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Check your local laws before enabling analytics.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ none: 'None', google: 'Google Analytics', plausible: 'Plausible', umami: 'Umami' })
          .setValue(site.analytics.provider)
          .onChange(async (value) => {
            site.analytics.provider = value as typeof site.analytics.provider
            await this.plugin.saveSettings()
            describeAnalytics()
          }),
      )
      // Put the provider dropdown above the ID field it controls.
      .settingEl.insertAdjacentElement('beforebegin', analyticsId.settingEl)

    describeAnalytics()
  }

  private renderMaintenance(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Maintenance').setHeading()

    const lastPublished = this.plugin.settings.lastPublishedAt
    new Setting(containerEl)
      .setName('Last publish')
      .setDesc(
        lastPublished
          ? `${new Date(lastPublished).toLocaleString()} (version ${this.plugin.settings.lastSnapshotId ?? 'unknown'})`
          : 'Nothing has been published from this device yet.',
      )

    new Setting(containerEl)
      .setName('Storage self-test')
      .setDesc(
        'Checks that your storage can do everything publishing needs. ' +
          'Only writes test files, and deletes them after.',
      )
      .addButton((button) =>
        button.setButtonText('Run self-test').onClick(async () => {
          button.setButtonText('Running…').setDisabled(true)
          await this.plugin.runStorageSelfTest()
          button.setButtonText('Run self-test').setDisabled(false)
        }),
      )

    // Wasabi bills a deleted object for the rest of its 90 days, so on that one
    // provider this button costs money rather than saving it. The warning
    // belongs here as much as in the picker: this is where it is spent.
    const cleanupCaution = providerById(this.plugin.settings.destination.provider).caution
    new Setting(containerEl)
      .setName('Clean up unused files')
      .setDesc(
        'Deletes files in your storage that your site no longer uses. ' +
          'Keeps the last 5 publishes and anything from the past week. It will not run while a publish is going.' +
          (cleanupCaution ? ` ${cleanupCaution}` : ''),
      )
      .addButton((button) =>
        button.setButtonText('Clean up').onClick(async () => {
          button.setButtonText('Checking…').setDisabled(true)
          await this.plugin.runGarbageCollection()
          button.setButtonText('Clean up').setDisabled(false)
        }),
      )

    new Setting(containerEl)
      .setName('Re-check every file')
      .setDesc('Makes the next scan check every file from scratch. Safe. It only makes that one scan slower.')
      .addButton((button) =>
        button.setButtonText('Clear').onClick(async () => {
          await this.plugin.clearHashCache()
          new Notice('Every file will be checked on the next scan.')
        }),
      )
  }

  override hide(): void {
    this.disposeRows()
    this.disposeRows = () => {}
  }

  private renderSecurityNote(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('About your credentials').setHeading()
    const note = containerEl.createDiv({ cls: 'setting-item-description op-security-note' })
    // The same fact either way, in the terms of whatever is actually stored.
    // Saying "these keys" to somebody who has none reads as boilerplate, and
    // boilerplate is what people stop reading.
    note.createEl('p', {
      text:
        this.plugin.settings.destination.type === 'gateway'
          ? 'Obsidian stores plugin settings as plain text in your vault, so any other plugin you install can read ' +
            'this token, and it syncs to your other devices. This is not encryption, and nothing can make it so. ' +
            'What it changes is reach: the token gets to your Worker, which gets to one bucket, and you can replace ' +
            'it with one command.'
          : 'Obsidian stores plugin settings as plain text in your vault, so any other plugin you install can read ' +
            'these keys, and they sync to your other devices. Use a token that can only reach this one bucket, ' +
            'and revoke it in a click if you need to.',
    })
  }
}
