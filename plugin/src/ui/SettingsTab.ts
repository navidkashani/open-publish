import { Notice, PluginSettingTab, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { SetupWizard } from './SetupWizard.ts'

export class OpenPublishSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: OpenPublishPlugin,
  ) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
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

  private renderStorage(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Storage').setHeading()
    const settings = this.plugin.settings.destination

    new Setting(containerEl)
      .setName('Endpoint')
      .setDesc('For Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com')
      .addText((text) =>
        text
          .setPlaceholder('https://….r2.cloudflarestorage.com')
          .setValue(settings.endpoint)
          .onChange(async (value) => {
            settings.endpoint = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl).setName('Bucket').addText((text) =>
      text.setValue(settings.bucket).onChange(async (value) => {
        settings.bucket = value.trim()
        await this.plugin.saveSettings()
      }),
    )

    new Setting(containerEl)
      .setName('Region')
      .setDesc('R2 uses "auto". S3 uses a real region such as eu-west-1.')
      .addText((text) =>
        text.setValue(settings.region).onChange(async (value) => {
          settings.region = value.trim() || 'auto'
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Access key ID')
      .setDesc('Use a token scoped to this bucket only, with read and write access.')
      .addText((text) =>
        text.setValue(settings.accessKeyId).onChange(async (value) => {
          settings.accessKeyId = value.trim()
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl).setName('Secret access key').addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(settings.secretAccessKey).onChange(async (value) => {
        settings.secretAccessKey = value.trim()
        await this.plugin.saveSettings()
      })
    })

    new Setting(containerEl)
      .setName('Key prefix')
      .setDesc('Optional. Lets one bucket hold several sites, e.g. "notes".')
      .addText((text) =>
        text.setValue(settings.prefix ?? '').onChange(async (value) => {
          settings.prefix = value.trim().replace(/^\/+|\/+$/g, '')
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Path-style addressing')
      .setDesc('On for R2, MinIO and most S3-compatible providers. Turn off only if your provider requires bucket-in-hostname URLs.')
      .addToggle((toggle) =>
        toggle.setValue(settings.forcePathStyle !== false).onChange(async (value) => {
          settings.forcePathStyle = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Writes a small test object, reads it back, then deletes it.')
      .addButton((button) =>
        button.setButtonText('Test').onClick(async () => {
          button.setButtonText('Testing…').setDisabled(true)
          const result = await this.plugin.testDestination()
          button.setButtonText('Test').setDisabled(false)
          new Notice(result.ok ? 'Storage is working.' : `${result.reason}${result.hint ? ' ' + result.hint : ''}`, result.ok ? 4000 : 10000)
        }),
      )
  }

  private renderBuild(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Site build').setHeading()
    const builder = this.plugin.settings.builder

    new Setting(containerEl)
      .setName('Deploy hook URL')
      .setDesc('Treat this like a password: anyone with it can start builds on your account.')
      .addText((text) => {
        text.inputEl.type = 'password'
        text.setValue(builder.url).onChange(async (value) => {
          builder.url = value.trim()
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName('Site URL')
      .setDesc('The live site, e.g. https://my-notes.pages.dev. Used to check when a build has gone live.')
      .addText((text) =>
        text.setValue(builder.siteUrl).onChange(async (value) => {
          builder.siteUrl = value.trim().replace(/\/+$/, '')
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Build logs URL')
      .setDesc('Optional. Shown when a build does not go live, so you can jump straight to the log.')
      .addText((text) =>
        text.setValue(builder.logsUrl).onChange(async (value) => {
          builder.logsUrl = value.trim()
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Build after publishing')
      .setDesc('Off means content is uploaded but the site is not rebuilt until you ask.')
      .addToggle((toggle) =>
        toggle.setValue(builder.autoTrigger).onChange(async (value) => {
          builder.autoTrigger = value
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Minimum minutes between builds')
      .setDesc(
        "Cloudflare Pages' free plan allows 500 builds a month and one at a time. " +
          'Publishes inside this window upload content but hold the build back.',
      )
      .addText((text) =>
        text.setValue(String(builder.minIntervalMinutes)).onChange(async (value) => {
          const parsed = Number(value)
          builder.minIntervalMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
          await this.plugin.saveSettings()
        }),
      )

    new Setting(containerEl)
      .setName('Check the site')
      .setDesc('Confirms the site URL responds and reports which snapshot it is serving. Does not start a build.')
      .addButton((button) =>
        button.setButtonText('Check').onClick(async () => {
          button.setButtonText('Checking…').setDisabled(true)
          const result = await this.plugin.testBuilder()
          button.setButtonText('Check').setDisabled(false)
          new Notice(result.reason ?? (result.ok ? 'Site is reachable.' : 'Check failed.'), result.ok ? 5000 : 10000)
        }),
      )
  }

  private renderSelection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('What gets published').setHeading()
    const selection = this.plugin.settings.selection

    new Setting(containerEl)
      .setName('Include folders')
      .setDesc('One folder per line. Notes inside them are published unless frontmatter says otherwise.')
      .addTextArea((text) => {
        text.inputEl.rows = 4
        text.setValue(selection.includes.join('\n')).onChange(async (value) => {
          selection.includes = splitLines(value)
          await this.plugin.saveSettings()
        })
      })

    new Setting(containerEl)
      .setName('Exclude folders')
      .setDesc('One folder per line. Checked before includes, so an exclude inside an include wins.')
      .addTextArea((text) => {
        text.inputEl.rows = 4
        text.setValue(selection.excludes.join('\n')).onChange(async (value) => {
          selection.excludes = splitLines(value)
          await this.plugin.saveSettings()
        })
      })

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

    const explicitCount = Object.keys(selection.explicit).length
    if (explicitCount > 0) {
      new Setting(containerEl)
        .setName('Per-file choices')
        .setDesc(`${explicitCount} file(s) have been individually included or excluded from the publish window.`)
        .addButton((button) =>
          button.setButtonText('Clear').onClick(async () => {
            selection.explicit = {}
            await this.plugin.saveSettings()
            this.display()
          }),
        )
    }
  }

  private renderSite(containerEl: HTMLElement): void {
    const site = this.plugin.settings.site

    new Setting(containerEl).setName('Site options').setHeading()
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'These travel inside the snapshot, so changing one rebuilds the site even when no notes changed. ' +
        'They describe what you want, not how a particular theme does it — a theme that cannot do one of these ignores it.',
    })

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
      .setName('Homepage')
      .setDesc(
        'Vault path of the note visitors land on, e.g. "Notes/Home.md". ' +
          'Leave empty to generate a simple index page. The note must be published.',
      )
      .addText((text) =>
        text
          .setPlaceholder('Notes/Home.md')
          .setValue(site.homepage)
          .onChange(async (value) => {
            site.homepage = value.trim().replace(/^\/+/, '')
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Discourage search engines')
      .setDesc(
        'Adds a robots rule asking search engines not to index the site. ' +
          'It is a request, not access control — anyone with the URL can still read everything.',
      )
      .addToggle((toggle) =>
        toggle.setValue(site.noIndex).onChange(async (value) => {
          site.noIndex = value
          await this.plugin.saveSettings()
        }),
      )

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

    new Setting(containerEl).setName('Reading').setHeading()

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

    new Setting(containerEl).setName('Components').setHeading()

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
          ? `${new Date(lastPublished).toLocaleString()} — snapshot ${this.plugin.settings.lastSnapshotId ?? 'unknown'}`
          : 'Nothing has been published from this device yet.',
      )

    new Setting(containerEl)
      .setName('Storage self-test')
      .setDesc(
        'Exercises the guarantees publishing depends on: content-addressed writes, deduplication, ' +
          'and the compare-and-swap that stops two devices overwriting each other. Touches only test keys.',
      )
      .addButton((button) =>
        button.setButtonText('Run self-test').onClick(async () => {
          button.setButtonText('Running…').setDisabled(true)
          await this.plugin.runStorageSelfTest()
          button.setButtonText('Run self-test').setDisabled(false)
        }),
      )

    new Setting(containerEl)
      .setName('Clean up unused files')
      .setDesc(
        'Deletes objects no recent snapshot refers to. Keeps the last 5 snapshots and anything from the past 7 days, ' +
          'and refuses to run while a publish is in progress.',
      )
      .addButton((button) =>
        button.setButtonText('Clean up').onClick(async () => {
          button.setButtonText('Checking…').setDisabled(true)
          await this.plugin.runGarbageCollection()
          button.setButtonText('Clean up').setDisabled(false)
        }),
      )

    new Setting(containerEl)
      .setName('Clear hash cache')
      .setDesc('Forces every file to be re-hashed on the next scan. Safe; only makes the next scan slower.')
      .addButton((button) =>
        button.setButtonText('Clear').onClick(async () => {
          await this.plugin.clearHashCache()
          new Notice('Hash cache cleared.')
        }),
      )
  }

  private renderSecurityNote(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('About your credentials').setHeading()
    const note = containerEl.createDiv({ cls: 'setting-item-description op-security-note' })
    note.createEl('p', {
      text:
        'Obsidian stores plugin settings in plain text inside your vault, and cannot sandbox plugins from one another. ' +
        'These keys are readable by any other plugin you install, and are synced to your other devices along with the vault.',
    })
    note.createEl('p', {
      text:
        'So the protection is scope, not secrecy: use a token that can only reach this one bucket, ' +
        'give the build environment a separate read-only token, and revoke either one in a click if you need to.',
    })
  }
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim().replace(/^\/+|\/+$/g, ''))
    .filter((line) => line.length > 0)
}
