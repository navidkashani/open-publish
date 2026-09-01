import { Notice, PluginSettingTab, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import {
  ROLLBACK_HEADLINE,
  hasHostMoved,
  hasStorageMoved,
  isRolledBack,
  rollbackWarning,
  storageMovedWarning,
} from '../settings.ts'
import { providerById } from '../destinations/providers.ts'
import { isAlwaysExcluded, parsePublishFrontmatter } from '../core/selection.ts'
import { isUrlStyle } from '../core/slug.ts'
import { LOCALES, directionFor, isLocale } from '../core/locales.ts'
import type { SiteToggleKey } from '../core/snapshot.ts'
import { FolderModal } from './FolderModal.ts'
import { RollbackModal } from './RollbackModal.ts'
import { folderRulesSummary, summarizeRules } from './FolderRules.ts'
import { PathSuggest, normalizeTypedPath } from './PathSuggest.ts'
import { renderRuleRows } from './RuleList.ts'
import type { Disposer } from './RuleList.ts'
import { BuildFields } from './BuildFields.ts'
import { SetupWizard } from './SetupWizard.ts'
import { StorageFields } from './StorageFields.ts'

const HOMEPAGE_DESC = 'The note visitors land on, e.g. "Notes/Home.md". It has to be a published note.'

/**
 * The toggles rendered by the loop under "Appearance".
 *
 * The light/dark control and strict line breaks are rendered on their own just
 * above it, because each needs a sentence of explanation the others do not.
 */
type AppearanceKey = Exclude<SiteToggleKey, 'showThemeToggle' | 'strictLineBreaks'>

/**
 * A record keyed by the option names themselves, and `satisfies` rather than an
 * annotation, so a site option added without a control here fails to compile.
 * The list this replaced was a bare union of string literals, unconnected to
 * `SnapshotSite`: a new option could be published with nothing to set it.
 */
const APPEARANCE = {
  showNavigation: { label: 'Navigation', desc: 'A list of published pages alongside the content.' },
  showSearch: { label: 'Search', desc: 'Search across page titles, headings and content.' },
  showGraph: { label: 'Graph view', desc: 'A small local graph on each page.' },
  showOutline: { label: 'Table of contents', desc: 'The outline of headings on each page.' },
  showBacklinks: { label: 'Backlinks', desc: 'Which published pages link to this one.' },
  showTags: { label: 'Tags', desc: "Show a page's tags, and give each tag its own page." },
} satisfies Record<AppearanceKey, { label: string; desc: string }>

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
   *
   * The heading is drawn even with nothing under it, which is the one case that
   * used to return early and so was invisible to everybody who had never made a
   * per-file choice. Publishing a single note is a real route and the only one
   * with no control anywhere on screen, so the empty state is where it gets
   * said. Nothing else follows it: no list, and nothing to clear.
   */
  private renderOverrides(containerEl: HTMLElement): void {
    const selection = this.plugin.settings.selection
    const paths = Object.keys(selection.explicit).sort()

    new Setting(containerEl)
      .setName('Per-file choices')
      .setDesc(
        paths.length === 0
          ? 'None yet. Right click any note and choose "Publish with Open Publish" to publish it on its own, ' +
            'wherever it lives.'
          : `${paths.length} ${paths.length === 1 ? 'file' : 'files'} individually included or excluded.`,
      )
    if (paths.length === 0) return

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

  /**
   * Whether old Obsidian Publish URLs keep working.
   *
   * The description carries the one condition that decides whether this is
   * worth anything, because the setting cannot check it: the redirects are
   * pages on *this* site, so they only meet a visitor who arrives at the domain
   * this site is served on. Somebody whose notes lived on
   * `publish.obsidian.md/username` is moving to an address they did not have
   * before, and nothing they host can catch a link to one they never owned.
   */
  private renderUrlStyle(containerEl: HTMLElement): void {
    const settings = this.plugin.settings

    new Setting(containerEl)
      .setName('Site URLs')
      .setDesc(
        'Pages always live at clean, lowercase addresses. If you are moving from Obsidian Publish and keeping ' +
          'the domain it was served on, the second option also puts a redirect at every URL Obsidian used, so ' +
          'existing links and search results still arrive. It cannot help with links to publish.obsidian.md.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            clean: 'Clean',
            'clean-with-redirects': 'Clean, keep my old links working',
          })
          .setValue(settings.urlStyle)
          .onChange(async (value) => {
            settings.urlStyle = isUrlStyle(value) ? value : 'clean'
            await this.plugin.saveSettings()
          }),
      )
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

    new Setting(containerEl)
      .setName('Language')
      .setDesc(
        'The language your notes are written in. It sets the language of the site chrome: the ' +
          'search box, the backlinks heading, the dates. It also tells browsers and search engines ' +
          'what they are reading. Arabic and Persian also lay the site out right to left.',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(Object.fromEntries(LOCALES.map((locale) => [locale.tag, locale.label])))
          .setValue(site.locale)
          .onChange(async (value) => {
            if (!isLocale(value)) return
            site.locale = value
            // Written together, always, so settings can never hold a direction
            // that disagrees with its language. `migrateSettings` re-derives it
            // on load for the same reason.
            site.dir = directionFor(value)
            await this.plugin.saveSettings()
          }),
      )

    this.renderHomepage(containerEl)
    this.renderUrlStyle(containerEl)

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

    for (const [key, { label, desc }] of Object.entries(APPEARANCE) as Array<
      [AppearanceKey, { label: string; desc: string }]
    >) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
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
    // The version is named only when it is still the one that publish produced.
    // A rollback moves `lastSnapshotId` and leaves `lastPublishedAt` where it
    // was, which is correct for both fields and a lie when read as one
    // sentence: it would date a publish that never happened. The panel above
    // says which version is live, so this drops back to the plain fact.
    const rolledBack = isRolledBack(this.plugin.settings)
    new Setting(containerEl)
      .setName('Last publish')
      .setDesc(
        lastPublished
          ? rolledBack
            ? new Date(lastPublished).toLocaleString()
            : `${new Date(lastPublished).toLocaleString()} (version ${this.plugin.settings.lastSnapshotId ?? 'unknown'})`
          : 'Nothing has been published from this device yet.',
      )

    // The panel, and not in Storage where `hasStorageMoved`'s lives. That one is
    // about where the bucket is; this one is about publish history, which is
    // what this section is for. Above the row it is about, so the explanation
    // arrives before the control.
    if (isRolledBack(this.plugin.settings)) {
      const box = containerEl.createDiv({ cls: 'op-notice-warning op-rolled-back' })
      box.createEl('p', { text: ROLLBACK_HEADLINE })
      box.createEl('p', { text: rollbackWarning(this.plugin.settings) ?? '' })
    }

    new Setting(containerEl)
      .setName('Site history')
      .setDesc('Make an earlier version of your site live again.')
      .addButton((button) =>
        button
          .setButtonText('Browse')
          // Repaint the whole tab afterwards: a rollback raises the panel above
          // and a roll forward clears it, and neither is visible from here.
          .onClick(() => new RollbackModal(this.app, this.plugin, () => this.display()).open()),
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
    //
    // What survived the move into Obsidian's keychain is the sentence that
    // matters most and the one a plugin can do least about. The keychain is one
    // namespace on the same `app` object every plugin is handed, and
    // `getSecret` is public API. It is out of your vault; it is not private.
    note.createEl('p', {
      text:
        this.plugin.settings.destination.type === 'gateway'
          ? "This token is kept in Obsidian's keychain rather than in your vault, so it does not travel with your " +
            'notes. Any other plugin you install can still read it. This is not encryption you control, and nothing ' +
            'can make it so. What it changes is reach: the token gets to your Worker, which gets to one bucket, and ' +
            'you can replace it with one command.'
          : "These keys are kept in Obsidian's keychain rather than in your vault, so they do not travel with your " +
            'notes. Any other plugin you install can still read them. Use a token that can only reach this one ' +
            'bucket, and revoke it in a click if you need to.',
    })
  }
}
