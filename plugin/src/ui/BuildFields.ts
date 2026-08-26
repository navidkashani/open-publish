/**
 * The build form, in one place.
 *
 * Settings and step 5 of the setup wizard were near-duplicates of each other,
 * exactly as the storage form was before `StorageFields` existed, so this is
 * the one copy of it. The two callers differ only in how the host is chosen (a
 * dropdown here, a row list on step 4 of the wizard) and where a check result
 * is shown.
 *
 * Three rules run through the whole file:
 *
 *  - **Nothing here reaches the wire.** The deploy hook URL stays the only
 *    thing posted and the site address the only thing polled. The host chooses
 *    what to call things and which free plan to quote, and `WebhookBuilder`
 *    never learns it exists.
 *  - **Inference applies itself and shows its work.** An exact hook-URL match
 *    is as high-confidence as this gets, so it relabels silently and prints one
 *    line saying where the label came from. No match changes nothing at all.
 *  - **Warnings are tiered by consequence.** A host's caveat is a line; only a
 *    free plan that a busy afternoon can exhaust gets a standing panel. When
 *    every warning arrives as an alarm, people learn one reflex and then use it
 *    on the one that mattered.
 */

import { Notice, Setting } from 'obsidian'
import type { BuilderTestResult } from '../builders/types.ts'
import { HOSTS, hostById, inferHost, isHostId } from '../builders/hosts.ts'
import type { Host, HostId } from '../builders/hosts.ts'
import { HOST_MOVED_WARNING, isBuilderReady } from '../settings.ts'
import type { WebhookBuilderSettings } from '../settings.ts'
import { advancedLabel, renderDisclosure, validateOnBlur } from './Disclosure.ts'
import { renderPickerList } from './PickerList.ts'

/** `info` is the in-progress line, which only a panel has anywhere to put. */
type Tone = 'ok' | 'error' | 'warning' | 'info'

const ADDRESS_PATTERN = /^https?:\/\/\S+$/i
const ADDRESS_ERROR = 'An address has to start with https:// or http://.'

export interface BuildFieldsOptions {
  builder: WebhookBuilderSettings
  save: () => Promise<void>
  /** Settings picks the host here; the wizard has already picked on step 4. */
  showHostPicker: boolean
  test: () => Promise<BuilderTestResult>
  /** True when the site is still being served by the host last published to. */
  hostMoved?: () => boolean
  /**
   * Called instead of re-rendering just this form when the host changes.
   * Settings uses it because copy outside this form depends on the host too.
   */
  onHostChange?: () => void
  /** How a check result is announced. Settings uses a Notice, the wizard a panel. */
  report?: (message: string, tone: Tone) => void
}

/**
 * Apply a host choice, in place.
 *
 * It really is one assignment, and that is the design rather than an oversight.
 * A host has no opinion about the hook URL, the site address, the wait between
 * builds or whether builds start automatically. Two of those govern somebody's
 * bill, and a picker is no basis for changing one. Compare `selectProvider`,
 * which rewrites an endpoint precisely because the endpoint is *derived*; a
 * deploy hook URL is opaque and can only be pasted.
 */
export function selectHost(builder: WebhookBuilderSettings, id: HostId): void {
  builder.host = id
}

/**
 * The one line under the host dropdown, saying where the label came from.
 *
 * Three states, and the third is scenario 7: an explicit pick that contradicts
 * the pasted URL. The pick stands, because it was deliberate, and the
 * disagreement is stated once rather than argued about in a dialog.
 */
export function hostNote(builder: Pick<WebhookBuilderSettings, 'host' | 'url'>): string | null {
  if (!builder.url.trim()) return null
  const inferred = inferHost(builder.url)
  if (inferred === 'other') return null
  if (inferred === builder.host) return 'Recognised from your deploy hook.'
  return `Your deploy hook looks like a ${hostById(inferred).name} one.`
}

/** What is behind Advanced that is not at its default, so a closed section is never opaque. */
export function buildAdvancedChanges(builder: Pick<WebhookBuilderSettings, 'logsUrl' | 'method'>): string[] {
  const changes: string[] = []
  if (builder.logsUrl.trim()) changes.push('build logs URL')
  if (builder.method !== 'POST') changes.push(`${builder.method} request`)
  return changes
}

export class BuildFields {
  private readonly host: HTMLElement
  private readonly options: BuildFieldsOptions

  /**
   * The two views of the host label: the dropdown and the line beneath it.
   * Both are repainted by `syncHost` when a hook URL is edited, rather than by
   * re-rendering, because re-rendering a form mid-keystroke takes the focus out
   * of the field being typed into.
   */
  /**
   * What the hook URL last looked like to `inferHost`.
   *
   * This is what makes inference act on *new evidence* rather than on every
   * keystroke. Without it, re-pasting or editing a hook URL silently reverted a
   * deliberate host choice, which made the "your deploy hook looks like a
   * Netlify one" line unreachable through the interface that shows it.
   *
   * An unrecognised URL is recorded as no evidence rather than as evidence of
   * "Another host", so deleting a hook URL and typing the same one back does
   * not count as something new.
   */
  private lastInferred: HostId = 'other'
  private hostDropdown: HTMLSelectElement | null = null
  private hostRow: Setting | null = null
  private hostNoteEl: HTMLElement | null = null
  private setAdvancedLabel: ((label: string) => void) | null = null

  constructor(container: HTMLElement, options: BuildFieldsOptions) {
    this.host = container.createDiv({ cls: 'op-build-fields' })
    this.options = options
  }

  private get builder(): WebhookBuilderSettings {
    return this.options.builder
  }

  private get chosen(): Host {
    return hostById(this.builder.host)
  }

  private save(): void {
    void this.options.save()
  }

  render(): void {
    this.host.empty()
    this.lastInferred = inferHost(this.builder.url)
    this.hostDropdown = null
    this.hostRow = null
    this.hostNoteEl = null

    if (this.options.hostMoved?.()) this.renderMovedWarning()
    if (this.options.showHostPicker) this.renderHostDropdown()

    this.renderHookUrl()
    this.renderSiteUrl()
    this.renderBuildOptions()
    this.renderAllowanceNotice()
    this.renderAdvanced()
    this.renderCheck()
  }

  private renderMovedWarning(): void {
    const box = this.host.createDiv({ cls: 'op-notice-warning op-host-moved' })
    box.createEl('p', { text: 'This is not the host your site was published to.' })
    box.createEl('p', { text: HOST_MOVED_WARNING })
  }

  /**
   * A dropdown here, a row list in the wizard, and never inside Advanced.
   *
   * Being able to correct an inferred value is the thing that makes inferring
   * one acceptable, so the control that corrects it stays visible whether or
   * not the guess was right.
   */
  private renderHostDropdown(): void {
    const options: Record<string, string> = {}
    for (const entry of HOSTS) {
      options[entry.id] = entry.recommended ? `${entry.name} (recommended)` : entry.name
    }

    const setting = new Setting(this.host).setName('Hosting provider')
    this.hostRow = setting
    this.paintHostRow()

    setting.addDropdown((dropdown) => {
      this.hostDropdown = dropdown.selectEl
      dropdown
        .addOptions(options)
        .setValue(this.builder.host)
        .onChange((value) => {
          if (!isHostId(value)) return
          this.pick(value)
        })
    })
  }

  /**
   * Everything the row says about the current host, rebuilt from scratch.
   *
   * `setDesc` replaces the description element's contents, so the caution and
   * the note have to be recreated after it rather than merely retargeted.
   * Getting that wrong meant pasting a Vercel hook relabelled the row and
   * silently dropped the one line explaining that renames will not redirect.
   */
  private paintHostRow(): void {
    const row = this.hostRow
    if (!row) return
    row.setDesc(this.chosen.summary)
    // The Log tier. Vercel's missing redirect support is worth knowing and is
    // not worth a panel, so it is a line under the control that chose it.
    if (this.chosen.caution) row.descEl.createDiv({ text: this.chosen.caution })
    this.hostNoteEl = row.descEl.createDiv({ cls: 'op-host-note' })
    this.syncHostNote()
  }

  /** Switching host changes a label and the copy around it, and nothing else. */
  pick(id: HostId): void {
    selectHost(this.builder, id)
    this.save()
    if (this.options.onHostChange) this.options.onHostChange()
    else this.render()
  }

  private renderHookUrl(): void {
    const setting = new Setting(this.host)
      .setName('Deploy hook URL')
      .setDesc('Treat this like a password: anyone with it can start builds on your account.')

    setting.addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(this.builder.url).onChange((value) => {
        this.builder.url = value.trim()
        this.syncHost()
        this.save()
      })
      validateOnBlur(setting, text.inputEl, ADDRESS_PATTERN, ADDRESS_ERROR)
    })
  }

  /**
   * Relabel from the pasted URL, without redrawing the form.
   *
   * Only an exact match applies itself. An unrecognisable URL leaves the label
   * exactly where it was, because "I cannot tell" is not evidence of anything
   * and overwriting a deliberate choice with a shrug would be worse than
   * showing a stale label.
   */
  private syncHost(): void {
    const inferred = inferHost(this.builder.url)
    // Nothing recognisable is not evidence of anything, so it changes nothing:
    // overwriting a deliberate choice with a shrug would be worse than showing
    // a stale label.
    if (inferred === 'other') {
      this.syncHostNote()
      return
    }
    const isNewEvidence = inferred !== this.lastInferred
    this.lastInferred = inferred
    // A URL that still says what it said before is not a reason to overrule the
    // person who picked something else on purpose. The line under the dropdown
    // states the disagreement instead.
    if (!isNewEvidence || inferred === this.builder.host) {
      this.syncHostNote()
      return
    }
    this.builder.host = inferred
    if (this.hostDropdown) this.hostDropdown.value = inferred
    // Everything else on this form that varies by host (the free plan quoted,
    // the allowance panel, the note under Site URL) is left until the next full
    // render. Redrawing a form around the field being typed into would take the
    // focus out of it, which is a worse bug than a line that is one keystroke
    // behind.
    this.paintHostRow()
  }

  private syncHostNote(): void {
    this.hostNoteEl?.setText(hostNote(this.builder) ?? '')
  }

  private renderSiteUrl(): void {
    const host = this.chosen
    const setting = new Setting(this.host)
      .setName('Site URL')
      .setDesc(`The live site, e.g. ${host.siteUrlExample}. Used to check when a build has gone live.`)

    // The hosts that provide no address of their own are the ones where this
    // field alone is not enough: the build needs telling too.
    if (host.siteUrlNote) setting.descEl.createDiv({ text: host.siteUrlNote })

    setting.addText((text) => {
      text.setValue(this.builder.siteUrl).onChange((value) => {
        this.builder.siteUrl = value.trim().replace(/\/+$/, '')
        this.save()
      })
      validateOnBlur(setting, text.inputEl, ADDRESS_PATTERN, ADDRESS_ERROR)
    })
  }

  /**
   * Both of these stay at top level, never behind Advanced.
   *
   * Progressive disclosure hides what is rarely needed. On Netlify these two
   * are the controls that decide whether a month's allowance survives the week,
   * which makes them the opposite of rarely needed.
   */
  private renderBuildOptions(): void {
    new Setting(this.host)
      .setName('Build after publishing')
      .setDesc('Off means content is uploaded but the site is not rebuilt until you ask.')
      .addToggle((toggle) =>
        toggle.setValue(this.builder.autoTrigger).onChange((value) => {
          this.builder.autoTrigger = value
          this.save()
        }),
      )

    new Setting(this.host)
      .setName('Minimum minutes between builds')
      .setDesc(`${this.chosen.allowance} Publishes inside this window upload content but hold the build back.`)
      .addText((text) =>
        text.setValue(String(this.builder.minIntervalMinutes)).onChange((value) => {
          const parsed = Number(value)
          this.builder.minIntervalMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
          this.save()
        }),
      )
  }

  /**
   * The Notify tier: inline, persistent, adjacent to the two controls that
   * spend the allowance, and never blocking anything.
   *
   * It says what the free plan is and what to do about it, and stops there. It
   * does not turn anything off, because changing a setting that governs
   * somebody's bill on the strength of an inference is exactly what the rest of
   * this design refuses to do.
   */
  private renderAllowanceNotice(): void {
    const notice = this.chosen.allowanceNotice
    if (!notice) return
    this.host.createDiv({ cls: 'op-notice-warning op-build-allowance', text: notice })
  }

  private renderAdvanced(): void {
    const changes = buildAdvancedChanges(this.builder)
    const { body, setLabel } = renderDisclosure(this.host, advancedLabel(changes), changes.length > 0)
    this.setAdvancedLabel = setLabel

    const setting = new Setting(body)
      .setName('Build logs URL')
      .setDesc('Optional. Shown when a build does not go live, so you can jump straight to the log.')
    setting.addText((text) => {
      text.setValue(this.builder.logsUrl).onChange((value) => {
        this.builder.logsUrl = value.trim()
        this.setAdvancedLabel?.(advancedLabel(buildAdvancedChanges(this.builder)))
        this.save()
      })
      validateOnBlur(setting, text.inputEl, ADDRESS_PATTERN, ADDRESS_ERROR)
    })

    // This existed in the settings file and in `WebhookConfig`, and was
    // reachable from nowhere, so only POST could ever be sent. Every host in
    // the catalogue takes POST, which is why nobody noticed; the one that needs
    // this is a hook behind a relay, and that is exactly the case "Another
    // host" exists for.
    new Setting(body)
      .setName('Request method')
      .setDesc('Deploy hooks take a POST. Switch to GET only if yours will not accept one.')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ POST: 'POST', GET: 'GET' })
          .setValue(this.builder.method)
          .onChange((value) => {
            this.builder.method = value === 'GET' ? 'GET' : 'POST'
            this.setAdvancedLabel?.(advancedLabel(buildAdvancedChanges(this.builder)))
            this.save()
          }),
      )
  }

  /**
   * The pre-flight, and worth encouraging rather than treating as optional.
   *
   * A wrong site address costs ten minutes and about forty-five requests at
   * publish time, because `waitForDeploy` correctly reads a 404 as "not built
   * yet". This button diagnoses the same mistake instantly, and deliberately
   * does not start a build: free plans are small enough that a test button
   * should not spend one uninvited.
   */
  private renderCheck(): void {
    new Setting(this.host)
      .setName('Check the site')
      .setDesc('Checks that your site is reachable and says which version it is showing. Does not start a build.')
      .addButton((button) =>
        button
          .setButtonText('Check')
          .setCta()
          .onClick(async () => {
            if (!isBuilderReady(this.builder)) {
              this.report('Fill in the deploy hook URL and the site URL first.', 'warning')
              return
            }
            button.setButtonText('Checking…').setDisabled(true)
            this.report('Checking…', 'info')
            const result = await this.options.test()
            button.setButtonText('Check').setDisabled(false)
            this.report(
              `${result.reason ?? (result.ok ? 'Site is reachable.' : 'Check failed.')}${result.hint ? ' ' + result.hint : ''}`,
              result.ok ? 'ok' : 'error',
            )
          }),
      )
  }

  private report(message: string, tone: Tone): void {
    if (this.options.report) {
      this.options.report(message, tone)
      return
    }
    // The button already reads "Checking…", so a Notice repeating it is noise.
    if (tone === 'info') return
    new Notice(message, tone === 'ok' ? 5000 : 10000)
  }
}

/**
 * The host rows, in the shared list component's terms.
 *
 * No extra line: a host's second sentence is its caution, and the ones that do
 * not have one have nothing more to say before the choice is made.
 */
export function renderHostList(container: HTMLElement, selected: HostId, onPick: (id: HostId) => void): void {
  renderPickerList(
    container,
    HOSTS.map((host) => ({
      id: host.id,
      name: host.name,
      recommended: host.recommended,
      summary: host.summary,
      caution: host.caution,
    })),
    selected,
    (id) => {
      if (isHostId(id)) onPick(id)
    },
  )
}
