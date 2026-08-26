/**
 * The storage form, in one place.
 *
 * Settings and the setup wizard were already near-duplicates of each other, and
 * a catalogue roughly doubles the branching in each, so this is the one copy of
 * it. The two callers differ only in how they pick a provider (a dropdown in
 * settings, a row list on step 1 of the wizard) and where a test result is
 * shown.
 *
 * Two rules run through the whole file:
 *
 *  - **Nothing here reaches the wire.** The endpoint string stays the only
 *    source of truth. The provider chooses what to prefill and what to call
 *    things, and `S3Destination` never learns it exists.
 *  - **Nothing the user chose is ever hidden.** Advanced starts closed only
 *    when every field inside it holds this provider's default, and its label
 *    says what is in there when it does not.
 */

import { Notice, Setting } from 'obsidian'
import type { ConcurrencySupport, TestResult } from '../destinations/types.ts'
import {
  PROVIDERS,
  advancedChanges,
  applyProvider,
  composeEndpoint,
  isProviderId,
  providerById,
  providerKind,
  variableValue,
} from '../destinations/providers.ts'
import type { ProviderId, StorageProvider } from '../destinations/providers.ts'
import {
  emptyGatewayDestination,
  emptyS3Destination,
  isDestinationReady,
} from '../settings.ts'
import type { DestinationSettings, GatewayDestinationSettings, S3DestinationSettings } from '../settings.ts'
import { advancedLabel, renderDisclosure, validateOnBlur } from './Disclosure.ts'
import { renderPickerList } from './PickerList.ts'

/** `info` is the in-progress line, which only a panel has anywhere to put. */
type Tone = 'ok' | 'error' | 'warning' | 'info'

/**
 * Caught here because it cannot be caught later.
 *
 * A prefix goes into a URL path, and a URL parser removes dot segments before
 * anything downstream sees them: `a/../b` addresses `b`. So a prefix containing
 * `..` does not fail, it silently reads and writes somewhere other than where
 * the field says. The gateway Worker refuses `..` outright, but only on the
 * listing route, where the prefix rides in a query string and nothing
 * normalises it. On every object it is already gone.
 *
 * Backslashes go the same way: a URL parser reads them as separators.
 */
const PREFIX_PATTERN = /^(?!.*\.\.)[^\\]*$/
const PREFIX_ERROR = 'A key prefix cannot contain ".." or a backslash. Both change which keys it addresses.'

export interface StorageFieldsOptions {
  /**
   * Read through a function, not held.
   *
   * Choosing a different *kind* of storage does not edit the destination, it
   * replaces it: a gateway has no bucket and no keys, and an S3 destination has
   * no Worker address. A reference taken at construction would go stale the
   * moment somebody switched, and the form would carry on writing into an
   * object nothing reads.
   */
  destination: () => DestinationSettings
  replaceDestination: (next: DestinationSettings) => void
  save: () => Promise<void>
  /** Settings picks the provider here; the wizard has already picked on step 1. */
  showProviderPicker: boolean
  test: () => Promise<TestResult>
  /**
   * The warning to show when the site's content lives somewhere other than
   * this, or null when it does not.
   *
   * Text rather than a boolean: which of the two warnings applies depends on
   * `lastPublishedTarget`, which this form does not have and should not need.
   */
  storageMoved?: () => string | null
  /**
   * Called instead of re-rendering just this form when the provider changes.
   * Settings uses it because copy outside this form depends on the provider
   * too, and a half-updated screen is worse than a slower one.
   */
  onProviderChange?: () => void
  /** How a test result is announced. Settings uses a Notice, the wizard a panel. */
  report?: (message: string, tone: Tone) => void
}

/**
 * Apply a provider choice to a stored destination, in place.
 *
 * Shared so the wizard's row list and the settings dropdown cannot drift into
 * applying the same choice two slightly different ways. Bucket, prefix and
 * credentials are deliberately untouched: a provider has no opinion about them.
 */
export function selectProvider(current: DestinationSettings, id: ProviderId): DestinationSettings {
  // Crossing between the two kinds keeps nothing, because the two shapes share
  // no fields. That also means switching *away* from a kind takes its
  // credentials out of `data.json`, which is the right way round: a key nothing
  // uses any more is pure added risk.
  if (providerKind(id) === 'gateway') {
    return current.type === 'gateway' ? current : emptyGatewayDestination()
  }

  const base: S3DestinationSettings = current.type === 'gateway' ? emptyS3Destination() : current
  const next = applyProvider(
    {
      provider: base.provider,
      endpoint: base.endpoint,
      region: base.region,
      // Absent means on, the way `s3.ts` reads it.
      forcePathStyle: base.forcePathStyle !== false,
    },
    id,
  )
  // Bucket, prefix and credentials ride along untouched: a provider has no
  // opinion about them.
  return { ...base, ...next, type: 's3' }
}

export class StorageFields {
  private readonly host: HTMLElement
  private readonly options: StorageFieldsOptions
  /**
   * What the last test actually found, as opposed to what the catalogue
   * expects. Session-local on purpose: a measurement is only true of the
   * configuration that produced it, and persisting it would mean keeping it
   * honest across every later edit for no benefit.
   */
  private measured: ConcurrencySupport | null = null

  /**
   * The three places one endpoint is visible: the blank it is built from, the
   * text under that blank, and the editable copy inside Advanced. They are kept
   * in step by `syncEndpoint`, because a stale copy is not merely untidy: type
   * an account ID with Advanced open, then touch the endpoint field, and the
   * stale value would be written straight back over the new one.
   */
  private endpointPreview: HTMLElement | null = null
  private endpointInput: HTMLInputElement | null = null
  private variableInput: HTMLInputElement | null = null
  private regionInput: HTMLInputElement | null = null

  constructor(container: HTMLElement, options: StorageFieldsOptions) {
    this.host = container.createDiv({ cls: 'op-storage-fields' })
    this.options = options
  }

  private get destination(): DestinationSettings {
    return this.options.destination()
  }

  private get provider(): StorageProvider {
    return providerById(this.destination.provider)
  }

  private save(): void {
    // Any edit here can invalidate what the last test measured. A row still
    // reading "Safe." after the endpoint changed is a claim about storage that
    // was never probed, so an edit retires the measurement and the row falls
    // back to what the catalogue merely expects.
    if (this.measured !== null) {
      this.measured = null
      this.concurrencyRow?.setDesc(concurrencyDescription(this.provider, null))
    }
    void this.options.save()
  }

  render(): void {
    this.host.empty()
    // Every one of these points at an element the empty() above just detached.
    this.endpointPreview = null
    this.endpointInput = null
    this.variableInput = null
    this.regionInput = null
    const provider = this.provider

    const moved = this.options.storageMoved?.()
    if (moved) this.renderMovedWarning(moved)
    if (this.options.showProviderPicker) this.renderProviderDropdown()
    if (provider.caution) {
      this.host.createDiv({ cls: 'op-notice-warning op-provider-caution', text: provider.caution })
    }

    const destination = this.destination
    if (destination.type === 'gateway') this.renderGatewayFields(destination)
    else this.renderS3Fields(destination)

    this.renderAdvanced()
    this.renderTest()
  }

  /** One address and one token, where the other branch has four fields. */
  private renderGatewayFields(destination: GatewayDestinationSettings): void {
    const { variable } = this.provider

    const address = new Setting(this.host).setName(variable.label)
    address.descEl.createDiv({ text: variable.help })
    address.addText((text) => {
      text
        .setPlaceholder(variable.placeholder)
        .setValue(destination.workerUrl)
        .onChange((value) => {
          destination.workerUrl = value.trim().replace(/\/+$/, '')
          this.save()
        })
      // On blur, never on change: an address is wrong for every character of
      // typing it, right up until it is not.
      validateOnBlur(address, text.inputEl, variable.pattern, variable.error)
    })

    new Setting(this.host)
      .setName('Token')
      .setDesc(
        'The value you set on the Worker with "wrangler secret put TOKEN". Nobody issues this one: you chose it, ' +
          'and you can change it on the Worker at any time.',
      )
      .addText((text) => {
        text.inputEl.type = 'password'
        text.setValue(destination.token).onChange((value) => {
          destination.token = value.trim()
          this.save()
        })
      })
  }

  private renderS3Fields(destination: S3DestinationSettings): void {
    this.renderVariableField(destination)

    new Setting(this.host).setName('Bucket').addText((text) =>
      text.setValue(destination.bucket).onChange((value) => {
        destination.bucket = value.trim()
        this.save()
      }),
    )

    new Setting(this.host)
      .setName('Access key ID')
      .setDesc('Use a token scoped to this bucket only, with read and write access.')
      .addText((text) =>
        text.setValue(destination.accessKeyId).onChange((value) => {
          destination.accessKeyId = value.trim()
          this.save()
        }),
      )

    new Setting(this.host).setName('Secret access key').addText((text) => {
      text.inputEl.type = 'password'
      text.setValue(destination.secretAccessKey).onChange((value) => {
        destination.secretAccessKey = value.trim()
        this.save()
      })
    })
  }

  private renderMovedWarning(warning: string): void {
    const box = this.host.createDiv({ cls: 'op-notice-warning op-storage-moved' })
    box.createEl('p', { text: 'This is not the storage your site was published to.' })
    box.createEl('p', { text: warning })
  }

  private renderProviderDropdown(): void {
    const options: Record<string, string> = {}
    for (const entry of PROVIDERS) {
      options[entry.id] = entry.recommended ? `${entry.name} (recommended)` : entry.name
    }

    new Setting(this.host)
      .setName('Storage provider')
      .setDesc(this.provider.summary)
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(options)
          .setValue(this.destination.provider)
          .onChange((value) => {
            if (!isProviderId(value)) return
            this.pick(value)
          }),
      )
  }

  /** Switching provider is the one edit that rewrites fields the user did not touch. */
  pick(id: ProviderId): void {
    this.options.replaceDestination(selectProvider(this.destination, id))
    // A measurement of the old provider says nothing about the new one. `save`
    // retires it; this is only here to say so at the place it matters most.
    this.measured = null
    this.save()
    if (this.options.onProviderChange) this.options.onProviderChange()
    else this.render()
  }

  /**
   * The one blank this provider asks for, with the endpoint it produces shown
   * underneath as plain text.
   *
   * The value is parsed back out of the endpoint rather than stored beside it,
   * so the two cannot drift apart, and the preview shows the endpoint that will
   * actually be used, including a hand-edited one. Otherwise this would be a
   * URL built for you that you cannot see.
   */
  private renderVariableField(destination: S3DestinationSettings): void {
    const provider = this.provider
    const { variable } = provider
    const setting = new Setting(this.host).setName(variable.label)
    setting.descEl.createDiv({ text: variable.help })

    // A free-form provider has no template, so the field *is* the endpoint and
    // a line repeating it back would be furniture.
    if (provider.endpointTemplate !== null) {
      this.endpointPreview = setting.descEl.createDiv({ cls: 'op-endpoint-preview' })
    }

    setting.addText((text) => {
      this.variableInput = text.inputEl
      text
        .setPlaceholder(variable.placeholder)
        .setValue(variableValue(provider.id, destination.endpoint))
        .onChange((value) => {
          destination.endpoint = composeEndpoint(provider.id, value)
          if (variable.isRegion) destination.region = value.trim() || 'auto'
          this.syncEndpoint('variable')
          this.save()
        })
      // On blur, never on change: validating an account ID per keystroke
      // flashes an error for the first thirty-one characters of a correct one.
      validateOnBlur(setting, text.inputEl, variable.pattern, variable.error)
    })

    this.syncEndpoint('variable')
  }

  /**
   * Repaint every view of the endpoint except the one being typed into.
   *
   * The region is part of this, not a separate concern. On the providers where
   * the region *is* the blank, editing the endpoint inside Advanced used to
   * change the address without changing the region it is signed for, and there
   * was no visible region field to notice it with. Every request then failed
   * with `SignatureDoesNotMatch`, which reads back to the user as "Storage
   * rejected these credentials" and sends them off to regenerate keys that were
   * never the problem.
   */
  private syncEndpoint(source: 'variable' | 'endpoint'): void {
    const destination = this.destination
    // A gateway has no endpoint, no region and none of these three inputs.
    if (destination.type !== 's3') return
    const endpoint = destination.endpoint
    if (source === 'endpoint' && this.provider.variable.isRegion) {
      const derived = variableValue(destination.provider, endpoint)
      // An endpoint that no longer matches the template has no region to give.
      // The last one stands, and the Region field below is how it gets fixed.
      if (derived) destination.region = derived
    }

    this.endpointPreview?.setText(`Your endpoint: ${endpoint || 'not set yet'}`)
    if (source === 'variable' && this.endpointInput) this.endpointInput.value = endpoint
    if (source === 'endpoint' && this.variableInput) {
      this.variableInput.value = variableValue(destination.provider, endpoint)
    }
    if (this.regionInput) this.regionInput.value = destination.region
    this.refreshAdvancedLabel()
  }

  // --- Advanced ----------------------------------------------------------

  private setAdvancedLabel: ((label: string) => void) | null = null

  private changes(): string[] {
    const destination = this.destination
    if (destination.type === 'gateway') {
      const prefix = (destination.prefix ?? '').replace(/^\/+|\/+$/g, '')
      return prefix ? [`key prefix "${prefix}"`] : []
    }
    return advancedChanges(destination.provider, destination)
  }

  private refreshAdvancedLabel(): void {
    this.setAdvancedLabel?.(advancedLabel(this.changes()))
  }

  private renderAdvanced(): void {
    const provider = this.provider
    const { body, setLabel } = renderDisclosure(this.host, advancedLabel(this.changes()), this.changes().length > 0)
    this.setAdvancedLabel = setLabel

    const destination = this.destination
    if (destination.type === 'gateway') {
      this.renderPrefixField(body, destination, {
        desc:
          'Optional, and a second prefix on top of the one the Worker enforces. Use it only if one gateway carries ' +
          'several sites. The Worker\'s own prefix is the part a stolen token cannot get around; this one is not.',
      })
      return
    }

    // The endpoint is only editable here, but it is readable above at all times.
    if (provider.endpointTemplate !== null) {
      const setting = new Setting(body)
        .setName('Endpoint')
        .setDesc('Built from the field above. Edit it only if your storage is behind a different address.')
      setting.addText((text) => {
        this.endpointInput = text.inputEl
        text.setValue(destination.endpoint).onChange((value) => {
          destination.endpoint = value.trim()
          this.syncEndpoint('endpoint')
          this.save()
        })
        validateOnBlur(setting, text.inputEl, /^https?:\/\/\S+$/i, 'An address has to start with https:// or http://.')
      })
    }

    // Rendered for every provider, including the ones where the region is the
    // blank above. It is redundant there right up until the endpoint stops
    // matching the template, and that is exactly the moment there has to be
    // somewhere to correct the region by hand.
    new Setting(body)
      .setName('Region')
      .setDesc(
        provider.variable.isRegion
          ? 'Taken from the endpoint. Worth changing only if your storage answers on a non-standard address.'
          : provider.fixedRegion
            ? `${provider.name} uses "${provider.fixedRegion}".`
            : 'Most S3-compatible storage accepts "auto". AWS-style providers want a real region.',
      )
      .addText((text) => {
        this.regionInput = text.inputEl
        text.setValue(destination.region).onChange((value) => {
          destination.region = value.trim() || 'auto'
          this.refreshAdvancedLabel()
          this.save()
        })
      })

    this.renderPrefixField(body, destination, {
      desc: 'Optional. Lets one bucket hold several sites, e.g. "notes".',
    })

    new Setting(body)
      .setName('Path-style addressing')
      .setDesc(
        provider.forcePathStyle
          ? `On for ${provider.name}. Turn it off only if your provider requires bucket-in-hostname URLs.`
          : `Off for ${provider.name}, which uses bucket-in-hostname URLs. Turning it on also means updating OP_FORCE_PATH_STYLE in your host's build settings.`,
      )
      .addToggle((pathStyle) =>
        pathStyle.setValue(destination.forcePathStyle !== false).onChange((value) => {
          destination.forcePathStyle = value
          this.refreshAdvancedLabel()
          this.save()
        }),
      )
  }

  /** The one Advanced row both kinds have, so both cannot drift on trimming it. */
  private renderPrefixField(
    body: HTMLElement,
    destination: DestinationSettings,
    copy: { desc: string },
  ): void {
    const setting = new Setting(body).setName('Key prefix').setDesc(copy.desc)
    setting.addText((text) => {
      text.setValue(destination.prefix ?? '').onChange((value) => {
        destination.prefix = value.trim().replace(/^\/+|\/+$/g, '')
        this.refreshAdvancedLabel()
        this.save()
      })
      validateOnBlur(setting, text.inputEl, PREFIX_PATTERN, PREFIX_ERROR)
    })
  }

  // --- what this storage can actually do ---------------------------------

  private concurrencyRow: Setting | null = null

  private renderTest(): void {
    new Setting(this.host)
      .setName('Test connection')
      .setDesc('Writes a small test object, reads it back, checks a conditional write, then deletes it.')
      .addButton((button) =>
        button
          .setButtonText('Test')
          .setCta()
          .onClick(async () => {
            if (!isDestinationReady(this.destination)) {
              this.report('Fill in every field above first.', 'warning')
              return
            }
            button.setButtonText('Testing…').setDisabled(true)
            this.report('Testing…', 'info')
            // Which storage this answer is about. Picking a different provider
            // mid-flight re-renders the row below, and pinning the old
            // provider's result to it would be worse than saying nothing.
            const asked = this.destination.provider
            const result = await this.options.test()
            button.setButtonText('Test').setDisabled(false)
            if (this.destination.provider !== asked) return

            this.measured = result.ok ? (result.conditionalWrites ?? null) : null
            this.concurrencyRow?.setDesc(concurrencyDescription(this.provider, this.measured))
            this.report(
              result.ok ? testSummary(this.measured) : `${result.reason}${result.hint ? ' ' + result.hint : ''}`,
              result.ok ? 'ok' : 'error',
            )
          }),
      )

    this.concurrencyRow = new Setting(this.host)
      .setName('Publishing from two devices')
      .setDesc(concurrencyDescription(this.provider, this.measured))
  }

  private report(message: string, tone: Tone): void {
    if (this.options.report) {
      this.options.report(message, tone)
      return
    }
    // The button already reads "Testing…", so a Notice repeating it is noise.
    // A panel has a place to put it; a toast queue does not.
    if (tone === 'info') return
    new Notice(message, tone === 'ok' ? 5000 : 10000)
  }
}

/**
 * The two-device sentence: the catalogue's expectation until something has
 * actually been measured, and the measurement afterwards.
 *
 * The expectation is never phrased as a fact for a provider we have not
 * confirmed, because a promise the storage then breaks is worse than no
 * promise at all.
 */
export function concurrencyDescription(provider: StorageProvider, measured: ConcurrencySupport | null): string {
  if (measured === 'enforced') {
    return 'Safe. If two devices publish at the same moment, the second is asked to try again.'
  }
  if (measured === 'ignored') {
    return 'Not safe. This storage accepted a write it should have refused, so two devices publishing at the same moment could overwrite each other.'
  }
  if (measured === 'unsupported') {
    return 'Weaker here. This storage has no conditional writes, so Open Publish reads before writing instead. Publishing works, but a publish can still be lost if two devices land at the same instant.'
  }
  return provider.expects === 'safe'
    ? 'Safe. If two devices publish at the same moment, the second is asked to try again.'
    : `${provider.concurrency} Use Test connection to find out now.`
}

/** What Test connection says when it passed. */
export function testSummary(measured: ConcurrencySupport | null): string {
  const base = 'Connected. Wrote a test object, read it back, and deleted it.'
  if (measured === 'enforced') return `${base} Two devices can publish safely.`
  if (measured === 'ignored') {
    return `${base} One thing to know: this storage ignored a conditional write, so two devices publishing at the same moment could overwrite each other.`
  }
  if (measured === 'unsupported') {
    return `${base} This storage has no conditional writes, so Open Publish reads before writing instead.`
  }
  return base
}

/**
 * The storage rows, in the shared list component's terms.
 *
 * The two-device sentence rides along as the extra line, because on this list
 * it is the second thing worth knowing about a provider and there is nowhere
 * better to say it before the choice is made.
 */
export function renderProviderList(
  container: HTMLElement,
  selected: ProviderId,
  onPick: (id: ProviderId) => void,
): void {
  renderPickerList(
    container,
    PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      recommended: provider.recommended,
      summary: provider.summary,
      caution: provider.caution,
      extra: provider.concurrency,
    })),
    selected,
    (id) => {
      if (isProviderId(id)) onPick(id)
    },
  )
}
