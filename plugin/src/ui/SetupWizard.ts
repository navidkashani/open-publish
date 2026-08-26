/**
 * Guided onboarding.
 *
 * Target: about ten minutes, no terminal, no cloning. The point of the per-step
 * Test buttons is that every step fails *here*, with a fixable sentence, rather
 * than three steps later as a build log nobody reads.
 */

import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { hasStorageMoved, isBuilderConfigured } from '../settings.ts'
import { providerById } from '../destinations/providers.ts'
import { addRule, removeRule, summarizeRules } from './FolderRules.ts'
import { renderFolderList } from './RuleList.ts'
import type { Disposer } from './RuleList.ts'
import { StorageFields, renderProviderList, selectProvider } from './StorageFields.ts'

interface Step {
  title: string
  render: (container: HTMLElement) => void
}

export class SetupWizard extends Modal {
  private stepIndex = 0
  private disposeRows: Disposer = () => {}
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property: Node's type stripping, which is what lets the test suites import
   * `src/**` with no build step, refuses that syntax outright.
   */
  private readonly plugin: OpenPublishPlugin

  constructor(app: App, plugin: OpenPublishPlugin) {
    super(app)
    this.plugin = plugin
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.renderStep()
  }

  override onClose(): void {
    this.disposeRows()
    this.contentEl.empty()
  }

  private steps(): Step[] {
    return [
      { title: 'Choose your storage', render: (c) => this.renderBucketStep(c) },
      { title: 'Connect the plugin to storage', render: (c) => this.renderCredentialsStep(c) },
      { title: 'Create the site repository', render: (c) => this.renderRepoStep(c) },
      { title: 'Connect hosting', render: (c) => this.renderHostingStep(c) },
      { title: 'Add the deploy hook', render: (c) => this.renderHookStep(c) },
      { title: 'Choose what to publish', render: (c) => this.renderSelectionStep(c) },
    ]
  }

  private renderStep(): void {
    const steps = this.steps()
    const step = steps[this.stepIndex]
    const { contentEl } = this
    this.disposeRows()
    contentEl.empty()

    contentEl.createEl('div', { cls: 'op-wizard-progress', text: `Step ${this.stepIndex + 1} of ${steps.length}` })
    contentEl.createEl('h2', { text: step.title })

    const body = contentEl.createDiv({ cls: 'op-wizard-body' })
    step.render(body)

    const actions = contentEl.createDiv({ cls: 'op-progress-actions' })
    if (this.stepIndex > 0) {
      const back = actions.createEl('button', { text: 'Back' })
      back.addEventListener('click', () => {
        this.stepIndex--
        this.renderStep()
      })
    }
    const isLast = this.stepIndex === steps.length - 1
    const next = actions.createEl('button', { cls: 'mod-cta', text: isLast ? 'Finish' : 'Next' })
    next.addEventListener('click', () => {
      if (isLast) {
        this.close()
        new Notice('Setup complete. Use the ribbon icon or the "Publish" command whenever you are ready.')
        return
      }
      this.stepIndex++
      this.renderStep()
    })
  }

  private instructions(container: HTMLElement, lines: string[]): void {
    const list = container.createEl('ol', { cls: 'op-wizard-steps' })
    for (const line of lines) list.createEl('li', { text: line })
  }

  /**
   * The picker, and instructions that swap with it. That is the whole mechanism.
   *
   * Nothing chosen here is ever sent anywhere: it decides what this step says
   * and what the next one prefills, and the endpoint string remains the only
   * thing the signer sees.
   */
  private renderBucketStep(container: HTMLElement): void {
    container.createEl('p', {
      text: 'Your notes live in storage you own. Nothing passes through a service run by anyone else.',
    })

    const destination = this.plugin.settings.destination
    renderProviderList(container, destination.provider, (id) => {
      selectProvider(destination, id)
      this.renderStep()
      void this.plugin.saveSettings()
    })

    const provider = providerById(destination.provider)
    this.instructions(container, provider.setup)

    if (provider.consoleUrl || provider.keysUrl) {
      const links = container.createDiv({ cls: 'op-wizard-links' })
      const link = (href: string, text: string): void => {
        links.createEl('a', { href, text, attr: { target: '_blank', rel: 'noopener' } })
      }
      if (provider.consoleUrl) link(provider.consoleUrl, `Open ${provider.name}`)
      if (provider.keysUrl) link(provider.keysUrl, 'How to create keys')
    }

    container.createEl('p', {
      cls: 'op-muted',
      text:
        'Two sets of keys, because they carry very different risk. The read-only pair only unlocks content that is ' +
        'already public on your site. The read-write pair can replace your site, so it stays scoped to this bucket ' +
        'and nothing else.',
    })
  }

  /**
   * The same form settings shows, minus the provider picker: step 1 already
   * chose, and Back is the way to change it.
   */
  private renderCredentialsStep(container: HTMLElement): void {
    const result = container.createDiv({ cls: 'op-wizard-result' })
    const fields = new StorageFields(container, {
      destination: this.plugin.settings.destination,
      save: () => this.plugin.saveSettings(),
      showProviderPicker: false,
      test: () => this.plugin.testDestination(),
      storageMoved: () => hasStorageMoved(this.plugin.settings),
      // Inline rather than a Notice: a wizard step that answers in a toast over
      // the top of itself is answering somewhere the user is not looking.
      report: (message, tone) => {
        result.className = `op-wizard-result op-notice-${tone}`
        result.setText(message)
      },
    })
    fields.render()
    // The result panel is created first so the callback can close over it, then
    // moved below the form it reports on.
    container.appendChild(result)
  }

  private renderRepoStep(container: HTMLElement): void {
    container.createEl('p', {
      text: 'The site generator lives in a Git repository. Your notes never go into it. Only the theme and build scripts do.',
    })
    this.instructions(container, [
      'Open the open-publish-quartz template on GitHub.',
      'Choose "Use this template" → "Create a new repository".',
      'Give it any name. There is nothing to clone and nothing to install locally.',
    ])
  }

  private renderHostingStep(container: HTMLElement): void {
    container.createEl('p', { text: 'Connect the repository to a host that builds it and serves the result.' })
    this.instructions(container, [
      'In Cloudflare, go to Workers & Pages → Create → Pages → Connect to Git, and pick the repository you just made.',
      'Framework preset: None. Build command: npm run build. Output directory: public.',
      'Open Settings → Environment variables and add the variables below, for both Production and Preview.',
      'Mark OP_SECRET_ACCESS_KEY as encrypted.',
    ])

    const destination = this.plugin.settings.destination
    const envLines = [
      `OP_ENDPOINT=${destination.endpoint || '<not set, go back a step>'}`,
      `OP_BUCKET=${destination.bucket || '<not set, go back a step>'}`,
      `OP_REGION=${destination.region || 'auto'}`,
      ...(destination.prefix ? [`OP_PREFIX=${destination.prefix}`] : []),
      // Without this line the build defaults path-style *on*
      // (`env.OP_FORCE_PATH_STYLE !== 'false'`), so anyone who turned the
      // toggle off got a plugin writing `bucket.endpoint/key` and a build
      // reading `endpoint/bucket/key`. The publish succeeds and the site then
      // cannot find `current.json`: a failure one step after the mistake, on a
      // machine the user cannot see.
      ...(destination.forcePathStyle === false ? ['OP_FORCE_PATH_STYLE=false'] : []),
      'OP_ACCESS_KEY_ID=<read-only key id>',
      'OP_SECRET_ACCESS_KEY=<read-only secret>',
    ]

    const values = container.createDiv({ cls: 'op-wizard-values' })
    values.createEl('div', { cls: 'op-muted', text: 'Environment variables for your Pages project:' })
    values.createEl('pre', { text: envLines.join('\n') })

    new Setting(values).addButton((button) =>
      button.setButtonText('Copy').onClick(async () => {
        await navigator.clipboard.writeText(envLines.join('\n'))
        new Notice('Copied. Fill in the two read-only values before pasting.')
      }),
    )

    // The last two lines are placeholders on purpose, and that looks like a bug
    // unless we say why.
    const note = container.createDiv({ cls: 'op-notice-info' })
    note.createEl('p', {
      text:
        'The last two values are blank on purpose. They are the read-only storage keys from step 1: the build uses ' +
        'them, the plugin never does, so Open Publish does not keep a copy.',
    })
    note.createEl('p', {
      text:
        'That separation is the point: the read-only keys only unlock content already published on your site, ' +
        'while the read-write keys in this plugin can replace the site. Storing both here would put them in one basket ' +
        'for no benefit. Copy them straight from your storage provider into your host, without a detour through here.',
    })
  }

  private renderHookStep(container: HTMLElement): void {
    this.instructions(container, [
      'In your Pages project, go to Settings → Builds & deployments → Deploy hooks.',
      'Create a hook for the main branch and copy the URL.',
      'Paste it below, along with the site URL Cloudflare gave you.',
    ])

    const builder = this.plugin.settings.builder
    new Setting(container).setName('Deploy hook URL').addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(builder.url).onChange(async (value) => {
        builder.url = value.trim()
        await this.plugin.saveSettings()
      })
    })
    new Setting(container)
      .setName('Site URL')
      .setDesc('e.g. https://my-notes.pages.dev')
      .addText((text) =>
        text.setValue(builder.siteUrl).onChange(async (value) => {
          builder.siteUrl = value.trim().replace(/\/+$/, '')
          await this.plugin.saveSettings()
        }),
      )

    const result = container.createDiv({ cls: 'op-wizard-result' })
    new Setting(container)
      .setDesc('Checks that the site responds. It does not start a build, because those are limited on free plans.')
      .addButton((button) =>
        button
          .setButtonText('Check site')
          .setCta()
          .onClick(async () => {
            if (!isBuilderConfigured(this.plugin.settings)) {
              result.className = 'op-wizard-result op-notice-warning'
              result.setText('Fill in both fields first.')
              return
            }
            result.className = 'op-wizard-result'
            result.setText('Checking…')
            const outcome = await this.plugin.testBuilder()
            result.className = `op-wizard-result ${outcome.ok ? 'op-notice-ok' : 'op-notice-error'}`
            result.setText(`${outcome.reason ?? ''}${outcome.hint ? ' ' + outcome.hint : ''}`.trim())
          }),
      )
  }

  private updateIncludes(includes: string[]): void {
    this.plugin.settings.selection.includes = includes
    this.renderStep()
    void this.plugin.saveSettings()
  }

  private renderSelectionStep(container: HTMLElement): void {
    container.createEl('p', {
      text:
        'Nothing is published until you say so. Add folders to publish, or put "publish: true" in a note\'s frontmatter. ' +
        'Frontmatter always wins over folder rules.',
    })

    // The same list component settings uses, so the counts are here too: seeing
    // "12 notes" the moment a folder is picked is the fastest way to find out
    // you picked the wrong one.
    const selection = this.plugin.settings.selection
    new Setting(container).setName('Folders to publish').setHeading()
    const summary = summarizeRules({
      files: this.app.vault.getFiles().map((file) => file.path),
      includes: selection.includes,
      excludes: selection.excludes,
      folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
    })
    this.disposeRows = renderFolderList({
      app: this.app,
      container,
      stats: summary.includes,
      taken: () => [...selection.includes, ...selection.excludes],
      placeholder: 'Add a folder…',
      emptyText: 'No folders yet. Leave it that way to rely on frontmatter alone.',
      onAdd: (rule) => this.updateIncludes(addRule(selection.includes, rule)),
      onRemove: (rule) => this.updateIncludes(removeRule(selection.includes, rule)),
    })

    new Setting(container).setName('Site title').addText((text) =>
      text.setValue(this.plugin.settings.site.title).onChange(async (value) => {
        this.plugin.settings.site.title = value
        await this.plugin.saveSettings()
      }),
    )

    container.createEl('p', {
      cls: 'op-muted',
      text:
        'One last thing worth knowing: these credentials sit in plain text in your vault and sync with it. ' +
        'Keep the keys scoped to this one bucket, and revoke them with your storage provider if you ever need to.',
    })
  }
}
