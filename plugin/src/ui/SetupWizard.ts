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
import { hasHostMoved, hasStorageMoved, storageMovedWarning } from '../settings.ts'
import { providerById } from '../destinations/providers.ts'
import { hostById } from '../builders/hosts.ts'
import { starterById } from '../builders/starters.ts'
import { renderStarterList } from './BuildFields.ts'
import { addRule, removeRule, summarizeRules } from './FolderRules.ts'
import { renderFolderList, ruleTargetExists } from './RuleList.ts'
import type { Disposer } from './RuleList.ts'
import { renderPublishImportRow } from './PublishImportModal.ts'
import { BuildFields, renderHostList, selectHost } from './BuildFields.ts'
import { StorageFields, renderProviderList, selectProvider } from './StorageFields.ts'
import type { DestinationStash } from './StorageFields.ts'

/**
 * Small counts read as words in this interface, not as digits. Anything past
 * the end of the list is a number, which is better than a wrong word.
 */
const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']

function inWords(count: number): string {
  return NUMBER_WORDS[count] ?? String(count)
}

interface Step {
  title: string
  render: (container: HTMLElement) => void
}

export class SetupWizard extends Modal {
  private stepIndex = 0
  private disposeRows: Disposer = () => {}
  /**
   * What step 1 set aside when the choice crossed between keys and a token, so
   * clicking back restores it. On the modal rather than in `renderBucketStep`,
   * because every pick re-renders the step and a local would not outlive the
   * click that filled it.
   */
  private readonly stash: DestinationStash = {}
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
        // "Whenever you are ready" was the wrong ending. Until a publish happens
        // there is nothing in storage, so the site cannot build and the host's
        // first attempt has already failed. Publishing is the step that makes
        // the previous six add up to a site.
        new Notice(
          'Setup complete. Publish now, from the ribbon icon or the "Publish" command: your site cannot build ' +
            'until there is something in your storage.',
          10000,
        )
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
   * The chosen option's caution, restated at the top of its panel.
   *
   * Said twice on purpose. On the row it is visible *before* choosing, which is
   * where it can still change the choice; here it belongs to the option now
   * selected, which is the only one whose steps are on screen. Storage and
   * hosting already do this once the choice is made, in `StorageFields` and
   * under the host row, and starters were the odd one out.
   */
  private caution(container: HTMLElement, text: string | undefined): void {
    if (text) container.createDiv({ cls: 'op-notice-warning', text })
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
    const provider = providerById(destination.provider)
    renderProviderList(
      container,
      destination.provider,
      (id) => {
        // Replaced, not edited: crossing between keys and a token changes the
        // shape of what is stored, and the credentials of the kind being left
        // behind go with it. The stash is what makes that survivable: click to
        // the gateway to read what it says, click back, and the endpoint and
        // bucket are still there.
        this.plugin.settings.destination = selectProvider(destination, id, this.stash)
        this.renderStep()
        void this.plugin.saveSettings()
      },
      (panel) => {
        this.caution(panel, provider.caution)
        this.instructions(panel, provider.setup)

        if (provider.consoleUrl || provider.keysUrl) {
          const links = panel.createDiv({ cls: 'op-wizard-links' })
          const link = (href: string, text: string): void => {
            links.createEl('a', { href, text, attr: { target: '_blank', rel: 'noopener' } })
          }
          if (provider.consoleUrl) link(provider.consoleUrl, provider.consoleLabel ?? `Open ${provider.name}`)
          if (provider.keysUrl) link(provider.keysUrl, provider.keysLabel ?? 'How to create keys')
        }
      },
    )

    // Below the list, not inside the panel. It is not a step: it says how this
    // plugin treats keys at all, which is as true before the choice as after,
    // and three lines of it inside one option's procedure pushed four of the
    // six options off the bottom of the screen. It still swaps with the kind of
    // destination chosen, because that is what it is about.
    container.createEl('p', {
      cls: 'op-muted',
      text:
        destination.type === 'gateway'
          ? 'One token instead of a key pair, and it is not a key: it reaches your Worker, and your Worker reaches ' +
            'one bucket. Your site build still needs a read-only key of its own, which is a much weaker credential ' +
            'and never passes through Obsidian.'
          : 'Two sets of keys, because they carry very different risk. The read-only pair only unlocks content that ' +
            'is already public on your site. The read-write pair can replace your site, so it stays scoped to this ' +
            'bucket and nothing else.',
    })

    this.renderSetAsideNotice(container)
  }

  /**
   * What the gateway is holding, and how long it holds it for.
   *
   * `selectProvider` sets the abandoned shape aside so switching back restores
   * it, which repaired the two-click round trip that used to empty a working
   * bucket. The stash lives as long as this modal and no longer, and that half
   * was still silent: close the guide here and the endpoint, bucket and key id
   * are gone, with the keychain entry orphaned behind them.
   *
   * Said on the step rather than caught on the way out. A modal cannot ask "are
   * you sure" without hijacking Escape and the close button, and a notice after
   * the fact would describe a loss nobody can undo. This is visible while the
   * choice is still reversible, which is the only moment it is worth anything.
   */
  private renderSetAsideNotice(container: HTMLElement): void {
    if (this.plugin.settings.destination.type !== 'gateway') return
    const setAside = this.stash.s3
    if (!setAside) return
    // Nothing typed in is nothing to lose. A fresh vault that opens the guide
    // and tries the gateway first has an empty shape set aside, and warning
    // about that would be noise on the one path where it costs nothing.
    if (!setAside.endpoint && !setAside.bucket && !setAside.accessKeyId) return

    const notice = container.createDiv({ cls: 'op-notice-warning' })
    notice.createEl('p', {
      text:
        `Your ${providerById(setAside.provider).name} details are set aside, not deleted. ` +
        'Pick that row again and the endpoint, bucket and key come back.',
    })
    notice.createEl('p', {
      text:
        'Closing this guide while the gateway is chosen does discard them, and nothing here can bring them back ' +
        'afterwards. Your secret stays in the keychain either way.',
    })
  }

  /**
   * The same form settings shows, minus the provider picker: step 1 already
   * chose, and Back is the way to change it.
   */
  private renderCredentialsStep(container: HTMLElement): void {
    const result = container.createDiv({ cls: 'op-wizard-result' })
    const fields = new StorageFields(container, {
      app: this.app,
      destination: () => this.plugin.settings.destination,
      replaceDestination: (next) => {
        this.plugin.settings.destination = next
      },
      save: () => this.plugin.saveSettings(),
      showProviderPicker: false,
      test: () => this.plugin.testDestination(),
      storageMoved: () =>
        hasStorageMoved(this.plugin.settings) ? storageMovedWarning(this.plugin.settings) : null,
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

  /**
   * The starter picker, and instructions that swap with it. The same mechanism
   * as steps 1 and 4, down to the component.
   *
   * The choice is stored for one reason beyond remembering it: the next step
   * has to tell the host where the build leaves the site, and the two starters
   * disagree. Nothing else about a publish changes.
   */
  private renderRepoStep(container: HTMLElement): void {
    container.createEl('p', {
      text: 'The site generator lives in a Git repository. Your notes never go into it. Only the theme and build scripts do.',
    })

    const builder = this.plugin.settings.builder
    const starter = starterById(builder.starter)
    renderStarterList(
      container,
      builder.starter,
      (id) => {
        builder.starter = id
        this.renderStep()
        void this.plugin.saveSettings()
      },
      (panel) => {
        this.caution(panel, starter.caution)
        // No "open the template on GitHub" step: the link below says the same
        // thing, and the link is the half that actually goes there.
        this.instructions(panel, [
          'Choose "Use this template" → "Create a new repository".',
          'Give it any name. There is nothing to clone and nothing to install locally.',
        ])

        const links = panel.createDiv({ cls: 'op-wizard-links' })
        links.createEl('a', {
          href: starter.repoUrl,
          text: `Open the ${starter.name} template`,
          attr: { target: '_blank', rel: 'noopener' },
        })
        if (starter.docsUrl) {
          links.createEl('a', {
            href: starter.docsUrl,
            text: 'How it builds from a snapshot',
            attr: { target: '_blank', rel: 'noopener' },
          })
        }
      },
    )

    container.createEl('p', {
      cls: 'op-muted',
      text:
        'Both build the same published notes from the same snapshot, so this decides how your site looks and ' +
        'nothing about what it contains. You can change your mind later by pointing your host at the other ' +
        'repository.',
    })
  }

  /**
   * The host picker, and instructions that swap with it. The same mechanism as
   * step 1, down to the component.
   *
   * Nothing chosen here is ever sent anywhere. It decides what this step says,
   * which free plan the next one quotes, and one line of the environment block.
   */
  private renderHostingStep(container: HTMLElement): void {
    container.createEl('p', {
      text:
        'Your host builds the site from the repository and serves it. ' +
        'Your notes are fetched from your storage at build time.',
    })

    const builder = this.plugin.settings.builder
    const host = hostById(builder.host)
    const starter = starterById(builder.starter)
    renderHostList(
      container,
      builder.host,
      (id) => {
        selectHost(builder, id)
        this.renderStep()
        void this.plugin.saveSettings()
      },
      (panel) => {
        this.caution(panel, host.caution)
        // The output directory in these steps is the starter's, not a constant:
        // Quartz builds into `public` and jotter into `dist`, and a host told
        // the wrong one deploys an empty directory and reports success.
        this.instructions(panel, host.setup(starter.build))
      },
    )

    // The one failure this guide *causes*, so it is the one it has to predict.
    // Connecting the repository starts a build immediately, and publishing is
    // the last thing anyone does here, so the first build always runs against
    // an empty bucket and always stops. Both starters refuse identically rather
    // than deploying an empty site over somebody's address, which is right, and
    // silent about it, which is not: a red build on a dashboard reads as "I got
    // something wrong" and sends people back through the steps looking for it.
    const firstBuild = container.createDiv({ cls: 'op-notice-info' })
    firstBuild.createEl('p', {
      text:
        'Your first build will fail, and that is expected. Connecting the repository starts a build straight ' +
        'away, and nothing has been published to your storage yet, so it stops with "No content has been ' +
        'published yet" rather than putting an empty site at your address.',
    })
    firstBuild.createEl('p', {
      text:
        'Finish this guide, including the deploy hook on the next step, then publish once from Obsidian. ' +
        'Publishing asks your host to rebuild on its own, and that build finds your notes.',
    })

    const destination = this.plugin.settings.destination
    // The build reads the bucket *directly*, whichever way the plugin writes to
    // it, so these lines are about storage rather than about the plugin's route
    // to it. A gateway user has to fill two of them in by hand, because the
    // Worker holds the bucket and the plugin genuinely does not know it. That
    // is worth saying out loud below: a guessed endpoint deploys perfectly and
    // builds an empty site.
    const storageLines =
      destination.type === 'gateway'
        ? [
            'OP_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com',
            'OP_BUCKET=<the bucket your Worker is bound to>',
            'OP_REGION=auto',
            // Always emitted, and always a blank, because the plugin's keys
            // land under the Worker's own PREFIX *and then* this vault's
            // prefix, and only the second half is knowable from here. Emitting
            // just the second half is the worse mistake of the two: with a
            // Worker prefix set, the build then reads the bucket root, finds
            // no current.json, and ships an empty site with nothing failing.
            `OP_PREFIX=<your Worker's PREFIX>${destination.prefix ? '/' + destination.prefix : ''}`,
          ]
        : [
            `OP_ENDPOINT=${destination.endpoint || '<not set, go back a step>'}`,
            `OP_BUCKET=${destination.bucket || '<not set, go back a step>'}`,
            `OP_REGION=${destination.region || 'auto'}`,
            ...(destination.prefix ? [`OP_PREFIX=${destination.prefix}`] : []),
            // Without this line the build defaults path-style *on*
            // (`env.OP_FORCE_PATH_STYLE !== 'false'`), so anyone who turned the
            // toggle off got a plugin writing `bucket.endpoint/key` and a build
            // reading `endpoint/bucket/key`. The publish succeeds and the site
            // then cannot find `current.json`: a failure one step after the
            // mistake, on a machine the user cannot see.
            ...(destination.forcePathStyle === false ? ['OP_FORCE_PATH_STYLE=false'] : []),
          ]

    const envLines = [
      ...storageLines,
      // The hosts that provide no address of their own need telling, or the
      // feed, the sitemap and the 404 page are written for example.com. The
      // build now stops rather than shipping that, which makes this line the
      // difference between a working build and a failed one.
      ...(host.siteUrlVariable === null ? [`OP_SITE_URL=${builder.siteUrl || '<your site address>'}`] : []),
      'OP_ACCESS_KEY_ID=<read-only key id>',
      'OP_SECRET_ACCESS_KEY=<read-only secret>',
    ]

    const values = container.createDiv({ cls: 'op-wizard-values' })
    values.createEl('div', { cls: 'op-muted', text: `Environment variables for your ${host.projectNoun}:` })
    values.createEl('pre', { text: envLines.join('\n') })

    // Counted rather than stated. The number moves with the host (two of them
    // add an OP_SITE_URL blank) and with the destination, and it is asserted as
    // a fact in a Notice somebody then acts on.
    const blanks = envLines.filter((line) => /<[^>]+>/.test(line)).length
    new Setting(values).addButton((button) =>
      button.setButtonText('Copy').onClick(async () => {
        // The clipboard is a permission, not a guarantee, and it is refused far
        // more often on a phone than on a desktop. Failing here silently would
        // be the worst version of it: the block above is the single most
        // important thing to carry out of this guide, and someone who believed
        // it copied would paste whatever was in the clipboard before.
        try {
          await navigator.clipboard.writeText(envLines.join('\n'))
        } catch {
          new Notice('Could not reach the clipboard. Select the block above and copy it by hand.', 8000)
          return
        }
        new Notice(`Copied. Fill in the ${inWords(blanks)} bracketed value${blanks === 1 ? '' : 's'} before pasting.`)
      }),
    )

    if (destination.type === 'gateway') {
      container.createEl('p', {
        cls: 'op-muted',
        text:
          'Your build reads the bucket directly, with its own read-only key, and the gateway changes nothing about ' +
          'that. Open Publish cannot fill in the endpoint, the bucket or the prefix for you here, because your ' +
          'Worker holds them and this plugin deliberately does not. The first two are on the R2 overview page. ' +
          "OP_PREFIX is your Worker's own PREFIX setting: if you left it empty, delete that part of the line, and " +
          'delete the whole line if what is left is empty too.',
      })
    }

    // Scenario 10: adding a custom domain in the host's dashboard moves the
    // pages and leaves the feed and the sitemap pointing at the address the
    // host generated. Nothing fails, so nobody finds out.
    if (host.siteUrlVariable !== null) {
      container.createEl('p', {
        cls: 'op-muted',
        text:
          'Putting a custom domain in front of this later? Add OP_SITE_URL with that address as well, ' +
          'or your feed and sitemap keep pointing at the address your host generated.',
      })
    }

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

    if (host.consoleUrl || host.docsUrl) {
      const links = container.createDiv({ cls: 'op-wizard-links' })
      const link = (href: string, text: string): void => {
        links.createEl('a', { href, text, attr: { target: '_blank', rel: 'noopener' } })
      }
      if (host.consoleUrl) link(host.consoleUrl, `Open ${host.name}`)
      if (host.docsUrl) link(host.docsUrl, `${host.name} docs`)
    }
  }

  /**
   * The same form settings shows, minus the host picker: step 4 already chose,
   * and Back is the way to change it.
   */
  private renderHookStep(container: HTMLElement): void {
    const builder = this.plugin.settings.builder
    this.instructions(container, hostById(builder.host).hookSetup)

    const result = container.createDiv({ cls: 'op-wizard-result' })
    const fields = new BuildFields(container, {
      builder,
      save: () => this.plugin.saveSettings(),
      showHostPicker: false,
      test: () => this.plugin.testBuilder(),
      hostMoved: () => hasHostMoved(this.plugin.settings),
      // Inline rather than a Notice, for the same reason step 2 is: a wizard
      // step that answers in a toast over the top of itself is answering
      // somewhere the user is not looking.
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

    // The only onboarding moment that asks what to publish, so it is the one
    // place a migrating user would otherwise retype their Publish folder list
    // by hand. `renderStep` disposes the rows first, so re-rendering from here
    // is safe.
    renderPublishImportRow({
      app: this.app,
      container,
      plugin: this.plugin,
      onDone: () => this.renderStep(),
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
      folderExists: (path) => ruleTargetExists(this.app, path),
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
        "One last thing worth knowing: your secret key is kept in Obsidian's keychain, on this device only, so it " +
        'does not travel with your vault and you will link it again on each device you publish from. Every other ' +
        'field here, the access key ID included, does sit in your vault. Keep the keys scoped to this one bucket, ' +
        'and revoke them with your storage provider if you ever need to.',
    })
  }
}
