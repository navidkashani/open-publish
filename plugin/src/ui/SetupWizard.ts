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
import { isBuilderConfigured, isDestinationConfigured } from '../settings.ts'

interface Step {
  title: string
  render: (container: HTMLElement) => void
}

export class SetupWizard extends Modal {
  private stepIndex = 0

  constructor(
    app: App,
    private readonly plugin: OpenPublishPlugin,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.renderStep()
  }

  override onClose(): void {
    this.contentEl.empty()
  }

  private steps(): Step[] {
    return [
      { title: 'Create a storage bucket', render: (c) => this.renderBucketStep(c) },
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

  private renderBucketStep(container: HTMLElement): void {
    container.createEl('p', {
      text: 'Your notes live in storage you own. Nothing passes through a service run by anyone else.',
    })
    this.instructions(container, [
      'Open the Cloudflare dashboard and go to R2.',
      'Create a bucket — "my-notes-publish" is a fine name. Leave it private.',
      'Note your Account ID from the R2 overview page; the endpoint URL contains it.',
      'Go to R2 → API Tokens and create a token with Object Read & Write, scoped to this bucket only. Save the key and secret.',
      'Create a second token with Object Read only, scoped to the same bucket. That one goes to the build in a later step.',
    ])
    container.createEl('p', {
      cls: 'op-muted',
      text:
        'Two tokens, because they carry very different risk. The read-only one only unlocks content that is already ' +
        'public on your site. The read-write one can replace your site, so it stays scoped to this bucket and nothing else.',
    })
  }

  private renderCredentialsStep(container: HTMLElement): void {
    const destination = this.plugin.settings.destination

    new Setting(container).setName('Endpoint').addText((text) =>
      text
        .setPlaceholder('https://<account-id>.r2.cloudflarestorage.com')
        .setValue(destination.endpoint)
        .onChange(async (value) => {
          destination.endpoint = value.trim()
          await this.plugin.saveSettings()
        }),
    )
    new Setting(container).setName('Bucket').addText((text) =>
      text.setValue(destination.bucket).onChange(async (value) => {
        destination.bucket = value.trim()
        await this.plugin.saveSettings()
      }),
    )
    new Setting(container).setName('Region').setDesc('R2 uses "auto".').addText((text) =>
      text.setValue(destination.region).onChange(async (value) => {
        destination.region = value.trim() || 'auto'
        await this.plugin.saveSettings()
      }),
    )
    new Setting(container).setName('Access key ID').addText((text) =>
      text.setValue(destination.accessKeyId).onChange(async (value) => {
        destination.accessKeyId = value.trim()
        await this.plugin.saveSettings()
      }),
    )
    new Setting(container).setName('Secret access key').addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(destination.secretAccessKey).onChange(async (value) => {
        destination.secretAccessKey = value.trim()
        await this.plugin.saveSettings()
      })
    })

    const result = container.createDiv({ cls: 'op-wizard-result' })
    new Setting(container).addButton((button) =>
      button
        .setButtonText('Test connection')
        .setCta()
        .onClick(async () => {
          if (!isDestinationConfigured(this.plugin.settings)) {
            result.className = 'op-wizard-result op-notice-warning'
            result.setText('Fill in every field above first.')
            return
          }
          result.className = 'op-wizard-result'
          result.setText('Testing…')
          const outcome = await this.plugin.testDestination()
          if (outcome.ok) {
            result.className = 'op-wizard-result op-notice-ok'
            result.setText('Connected. Wrote a test object, read it back, and deleted it.')
          } else {
            result.className = 'op-wizard-result op-notice-error'
            result.setText(`${outcome.reason}${outcome.hint ? ' ' + outcome.hint : ''}`)
          }
        }),
    )
  }

  private renderRepoStep(container: HTMLElement): void {
    container.createEl('p', {
      text: 'The site generator lives in a Git repository. Your notes never go into it — only the theme and build scripts do.',
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
      `OP_ENDPOINT=${destination.endpoint || '<not set — go back a step>'}`,
      `OP_BUCKET=${destination.bucket || '<not set — go back a step>'}`,
      `OP_REGION=${destination.region || 'auto'}`,
      ...(destination.prefix ? [`OP_PREFIX=${destination.prefix}`] : []),
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
        'The last two values are blank on purpose. They are the read-only token from step 1 — the build uses it, ' +
        'the plugin never does, so Open Publish does not keep a copy.',
    })
    note.createEl('p', {
      text:
        'That separation is the point: the read-only token only unlocks content already published on your site, ' +
        'while the read-write token in this plugin can replace the site. Storing both here would put them in one basket ' +
        'for no benefit. Paste it straight from Cloudflare into Cloudflare.',
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
      .setDesc('Checks that the site responds. It does not start a build — those are limited on free plans.')
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

  private renderSelectionStep(container: HTMLElement): void {
    container.createEl('p', {
      text:
        'Nothing is published until you say so. Add folders to publish, or put "publish: true" in a note\'s frontmatter — ' +
        'frontmatter always wins over folder rules.',
    })

    const selection = this.plugin.settings.selection
    new Setting(container)
      .setName('Folders to publish')
      .setDesc('One per line. Leave empty to rely on frontmatter alone.')
      .addTextArea((text) => {
        text.inputEl.rows = 4
        text.setValue(selection.includes.join('\n')).onChange(async (value) => {
          selection.includes = value
            .split('\n')
            .map((line) => line.trim().replace(/^\/+|\/+$/g, ''))
            .filter(Boolean)
          await this.plugin.saveSettings()
        })
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
        'Keep the token scoped to this one bucket, and revoke it from the Cloudflare dashboard if you ever need to.',
    })
  }
}
