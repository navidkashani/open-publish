/**
 * The Obsidian Publish import: its preview, and the row that offers it.
 *
 * Both live here so the copy cannot drift. The sentence on the entry row is
 * the one somebody decides on, and it is shown in two places (Manage folders
 * and step 6 of the setup guide), which is the same reason `StorageFields` and
 * `BuildFields` are shared components rather than two forms that agree today.
 *
 * Read-only, deliberately. An editable preview would be a second rule editor
 * for what `FolderModal` already edits better, and two editors of the same
 * thing drift. Nothing is published until a publish runs, so adjusting
 * afterwards costs nothing.
 *
 * One divergence worth knowing about before it reads as an inconsistency. The
 * headline count walks the vault through `getPublishFlag` with the real
 * frontmatter, exactly as `scanner.ts` does, so it is the number a publish
 * would actually produce. The per-rule counts beside each row come from
 * `summarizeRules`, which deliberately ignores frontmatter (its header says
 * why: it is recomputed on every keystroke in the dialog it was built for).
 * This screen is opened by hand and redrawn only when a box below is ticked,
 * and it carries the single most privacy-critical number in the plugin, so it
 * can afford the walk. When the two disagree, a line under the lists says why.
 *
 * The one part of this screen that is not a preview: the notes Publish may have
 * published individually. Those selections live on Obsidian's servers and this
 * plugin does not talk to Obsidian, so the offer is inferred from the one trace
 * left in the vault, a `permalink`, and offered with every box empty. Ticking
 * one re-renders, because the headline and the button describe what Import will
 * do and both have to move.
 */

import { Modal, Notice, Setting } from 'obsidian'
import type { App } from 'obsidian'
import type OpenPublishPlugin from '../main.ts'
import { looksLikeObsidianPublish, parsePublishConfig } from '../core/publishconfig.ts'
import type { DroppedEntry, PublishConfig } from '../core/publishconfig.ts'
import { extensionOf, getPublishFlag } from '../core/selection.ts'
import type { SelectionRules } from '../core/selection.ts'
import { DEAD_RULE_WARNING, noteCountLabel, summarizeRules } from './FolderRules.ts'
import type { RuleSummary } from './FolderRules.ts'
import { renderRuleRows, ruleTargetExists } from './RuleList.ts'
import type { RuleRow } from './RuleList.ts'
import { renderDisclosure } from './Disclosure.ts'
import {
  EXCLUDES_KEPT_NOTE,
  LEGACY_URL_OFFER,
  LEGACY_URL_TOGGLE,
  SITE_OPTION_CARRYOVER,
  SITE_OPTION_CARRYOVER_HEADING,
  SITE_OPTION_CARRYOVER_INTRO,
  SITE_OPTION_NOT_HERE,
  UNCLAIMED_PERMALINK_BLIND_SPOT,
  UNCLAIMED_PERMALINK_HEADING,
  UNCLAIMED_PERMALINK_LIMIT,
  UNCLAIMED_PERMALINK_OFFER,
  effectLabel,
  importBlockedReason,
  importButtonLabel,
  importSentence,
  importWarnings,
  importedNotice,
  planPublishImport,
  unclaimedPermalinks,
  unclaimedRemainderNote,
} from './PublishImport.ts'
import type { ImportPlan, PublishedCount, UnclaimedPermalink } from './PublishImport.ts'

export interface PublishImportSource {
  config: PublishConfig
  dropped: DroppedEntry[]
}

export class PublishImportModal extends Modal {
  private readonly plugin: OpenPublishPlugin
  private readonly source: PublishImportSource
  private readonly onDone: () => void
  /**
   * Whether to also answer at the old Publish addresses.
   *
   * Null until the offer has been made once, and pre-ticked when it is. The
   * tri-state is what stops a re-render from re-arming a toggle somebody has
   * just turned off: `render()` runs again on every tick below.
   */
  private keepLegacyUrls: boolean | null = null

  /**
   * Notes ticked in the offer below, held here rather than read back off the
   * checkboxes, because the redraw destroys them.
   */
  private readonly ticked: Record<string, boolean> = {}

  // Written out rather than as constructor parameter properties: Node's
  // type-stripping cannot erase those, and the test suite runs this file.
  constructor(app: App, plugin: OpenPublishPlugin, source: PublishImportSource, onDone: () => void = () => {}) {
    super(app)
    this.plugin = plugin
    this.source = source
    this.onDone = onDone
  }

  override onOpen(): void {
    this.modalEl.addClass('op-modal')
    this.setTitle('Import from Obsidian Publish')
    this.render()
  }

  override onClose(): void {
    this.contentEl.empty()
    this.onDone()
  }

  private render(): void {
    const { contentEl } = this
    contentEl.empty()

    const selection = this.plugin.settings.selection
    const plan = planPublishImport(this.source.config, selection)

    const files = this.app.vault.getFiles().map((file) => file.path)
    // Also accepts a file, because `matchesFolderRule` matches an exact file
    // path too. Publish filters normally name folders, and telling somebody
    // their existing note "no longer exists" would be plainly wrong.
    const folderExists = (path: string): boolean => ruleTargetExists(this.app, path)
    const before = summarizeRules({ files, includes: selection.includes, excludes: selection.excludes, folderExists })
    const after = summarizeRules({ files, includes: plan.includes, excludes: plan.excludes, folderExists })

    const planned: SelectionRules = { includes: plan.includes, excludes: plan.excludes, explicit: selection.explicit }
    const candidates = this.candidatesFor(planned)
    const ticked = Object.keys(this.ticked)

    const publishedNow = this.countPublished(selection)
    // Twice, and only when something is ticked: the rules on their own are what
    // the per-rule rows sum to, and the rules plus the ticks are the headline.
    const publishedFromRules = this.countPublished(planned)
    const publishedAfter =
      ticked.length === 0
        ? publishedFromRules
        : this.countPublished({ ...planned, explicit: { ...selection.explicit, ...this.ticked } })

    contentEl.createEl('p', { cls: 'op-rule-intro', text: importSentence(plan, publishedNow, publishedAfter) })

    if (!plan.empty) {
      new Setting(contentEl).setName('Included').setHeading()
      renderRuleRows(contentEl, this.rowsFor('includes', plan, before, after), 'No folders.')

      new Setting(contentEl).setName('Excluded').setHeading()
      renderRuleRows(contentEl, this.rowsFor('excludes', plan, before, after), 'Nothing is being held back.')

      if (after.published !== publishedFromRules.notes + publishedFromRules.attachments) {
        contentEl.createEl('p', {
          cls: 'op-muted',
          text:
            'Some notes set publish: in their frontmatter, which wins over any folder rule. That is why the ' +
            'total above is not the sum of the counts beside each folder.',
        })
      }

      if (plan.excludes.length > 0) {
        contentEl.createEl('p', { cls: 'op-muted', text: EXCLUDES_KEPT_NOTE })
      }
    }

    for (const warning of importWarnings({
      plan,
      after,
      dropped: this.source.dropped,
      live: this.plugin.settings.lastPublishedAt !== null,
    })) {
      contentEl.createDiv({ cls: 'op-notice-warning', text: warning })
    }

    this.renderUnclaimed(contentEl, candidates)
    this.renderUrlOffer(contentEl, plan)
    this.renderCarryover(contentEl)

    const blocked = importBlockedReason(plan, ticked.length)
    if (blocked) contentEl.createEl('p', { cls: 'op-muted', text: blocked })

    const actions = contentEl.createDiv({ cls: 'op-progress-actions' })
    const cancel = actions.createEl('button', { text: 'Cancel' })
    // The consequential button is not adjacent to the benign one: this is the
    // one press in the plugin that can change what is public. The row is
    // right-aligned, so pushing Cancel away from Import is a left shove.
    cancel.style.marginRight = 'auto'
    cancel.addEventListener('click', () => this.close())

    const label = importButtonLabel(plan, publishedAfter, ticked.length)
    const confirm = actions.createEl('button', { cls: 'mod-cta', text: label })
    confirm.disabled = blocked !== null
    // Deliberately never focused. A plan containing removals must not be
    // confirmable by pressing Enter on a window somebody has not read.
    confirm.addEventListener('click', () => this.commit(plan, publishedAfter))
  }

  /**
   * Notes a permalink says Obsidian Publish probably served on its own.
   *
   * Resolved against the *planned* rules, so a note a folder already covers is
   * never offered, and against the vault's saved `explicit` map rather than the
   * ticks: a candidate that disappeared the moment it was ticked would be an
   * unusable list.
   */
  private candidatesFor(planned: SelectionRules): UnclaimedPermalink[] {
    return unclaimedPermalinks(
      this.app.vault.getFiles().map((file) => {
        const frontmatter = this.app.metadataCache.getCache(file.path)?.frontmatter
        return {
          path: file.path,
          permalink: frontmatter?.['permalink'],
          flag: getPublishFlag(file.path, frontmatter?.['publish'], planned),
        }
      }),
    )
  }

  /**
   * The offer, with every box empty.
   *
   * Shown even when the plan is empty, because that is the case where it
   * matters most: a Publish site that selected everything note by note has an
   * empty `included` list and would otherwise be a dead end.
   *
   * The asymmetry runs the other way from the URL offer directly beneath it.
   * Wrongly on there costs a redirect page nobody visits; wrongly on here
   * publishes a private note. So these are unticked, and this is an offer
   * rather than an import: a permalink is a note saying "I have a fixed public
   * address", which is good evidence and a poor rule.
   */
  private renderUnclaimed(container: HTMLElement, candidates: UnclaimedPermalink[]): void {
    if (candidates.length === 0) return

    new Setting(container).setName(UNCLAIMED_PERMALINK_HEADING).setHeading()
    container.createEl('p', { cls: 'op-rule-intro', text: UNCLAIMED_PERMALINK_OFFER })

    for (const candidate of candidates.slice(0, UNCLAIMED_PERMALINK_LIMIT)) {
      new Setting(container)
        .setName(candidate.path)
        .setDesc(candidate.permalink)
        .addToggle((toggle) =>
          toggle.setValue(this.ticked[candidate.path] === true).onChange((value) => {
            if (value) this.ticked[candidate.path] = true
            else delete this.ticked[candidate.path]
            // The headline and the button say what Import will do, so both have
            // to move. The same redraw `FolderModal` does after a mutation.
            this.render()
          }),
        )
    }

    const remainder = unclaimedRemainderNote(candidates.length)
    if (remainder) container.createEl('p', { cls: 'op-muted', text: remainder })
    container.createEl('p', { cls: 'op-muted', text: UNCLAIMED_PERMALINK_BLIND_SPOT })
  }

  /**
   * The offer to keep the old addresses answering, shown only when this really
   * was a Publish site and only when the setting is still at its default.
   *
   * Pre-ticked, because the asymmetry decides it: wrongly on costs a handful of
   * redirect pages nobody visits, and wrongly off costs every inbound link and
   * every search ranking, permanently, discovered weeks later. It is asked
   * rather than inferred because `publish.json` proves they used Publish and
   * says nothing about whether they kept the domain, which is the whole
   * question. And it is asked rather than set silently because it changes what
   * the site serves, and nobody should find a setting they never chose in a
   * section they were not looking at. A deliberate earlier choice is never
   * re-asked or overwritten.
   */
  private renderUrlOffer(container: HTMLElement, plan: ImportPlan): void {
    if (plan.empty) return
    if (this.plugin.settings.urlStyle !== 'clean') return
    if (!looksLikeObsidianPublish(this.source.config)) return

    // Pre-ticked on the first pass only. `??=` is doing the work: a redraw after
    // a note is ticked must not undo an answer already given here.
    this.keepLegacyUrls ??= true
    new Setting(container)
      .setName(LEGACY_URL_TOGGLE)
      .setDesc(LEGACY_URL_OFFER)
      .addToggle((toggle) =>
        toggle.setValue(this.keepLegacyUrls === true).onChange((value) => {
          this.keepLegacyUrls = value
        }),
      )
  }

  /**
   * The settings a migrating site has to bring across by hand.
   *
   * Gated on the same evidence as the URL offer above, and for a plainer reason:
   * a hand-made `publish.json` was never a Publish site, so there are no Publish
   * site options sitting behind it to copy. Shown when the plan is empty, unlike
   * that offer, because a site that picked every note by hand still has a site
   * name and an analytics ID.
   *
   * Started closed. `Disclosure.ts` allows that only when nothing the user chose
   * is hidden, and nothing here was chosen: it holds no controls and no state, so
   * closing it hides no answer. What it buys is that the headline count, the most
   * privacy-critical number in the plugin, stays the first thing on screen
   * instead of being pushed off the top by a list of settings to retype.
   *
   * Writes nothing. `commit` never sees this.
   */
  private renderCarryover(container: HTMLElement): void {
    if (!looksLikeObsidianPublish(this.source.config)) return

    const { body } = renderDisclosure(container, SITE_OPTION_CARRYOVER_HEADING, false)
    body.createEl('p', { cls: 'op-rule-intro', text: SITE_OPTION_CARRYOVER_INTRO })
    for (const row of SITE_OPTION_CARRYOVER) {
      new Setting(body).setName(row.publish).setDesc(row.here)
    }
    body.createEl('p', { cls: 'op-muted', text: SITE_OPTION_NOT_HERE })
  }

  /** One row per rule: its count, its effect, and whether it names anything. */
  private rowsFor(
    list: 'includes' | 'excludes',
    plan: ImportPlan,
    before: RuleSummary,
    after: RuleSummary,
  ): RuleRow[] {
    return plan.changes
      .filter((change) => change.list === list)
      .map((change) => {
        // A rule being dropped is not in the plan, so its count has to come
        // from the rules as they stand: that number is what stops publishing.
        const summary = change.effect === 'removed' ? before : after
        const stat = summary[list].find((candidate) => candidate.rule === change.rule)
        return {
          path: change.rule,
          icon: 'folder',
          meta: `${noteCountLabel(stat?.count ?? 0)} · ${effectLabel(change.effect)}`,
          warning: stat && !stat.exists ? DEAD_RULE_WARNING : null,
        }
      })
  }

  /**
   * What a publish would actually publish under these rules.
   *
   * The `explicit` map and the frontmatter both stay in play, because both
   * outrank folder rules and neither is touched by an import.
   */
  private countPublished(rules: SelectionRules): PublishedCount {
    const count: PublishedCount = { notes: 0, attachments: 0 }
    for (const file of this.app.vault.getFiles()) {
      const frontmatter = this.app.metadataCache.getCache(file.path)?.frontmatter
      if (getPublishFlag(file.path, frontmatter?.['publish'], rules) !== true) continue
      if (extensionOf(file.path) === 'md') count.notes++
      else count.attachments++
    }
    return count
  }

  /**
   * Two arrays, the ticked notes, and, if it was offered and left ticked, one
   * URL setting. Nothing else.
   */
  private commit(plan: ImportPlan, publishedAfter: PublishedCount): void {
    const selection = this.plugin.settings.selection
    const ticked = Object.keys(this.ticked)

    // An empty plan has no folders to write, and writing its empty include list
    // would delete the rules this vault already has. "Nothing to import" must
    // never mean "everything to remove", and this path is reachable now that a
    // ticked note unblocks Import.
    if (!plan.empty) {
      selection.includes = [...plan.includes]
      selection.excludes = [...plan.excludes]
    }
    // Ticked notes only. An unticked candidate is "no opinion", and writing
    // `false` there would invent a refusal nobody made, one that then outranks
    // any folder rule they add later.
    for (const path of ticked) selection.explicit[path] = true
    if (this.keepLegacyUrls === true) this.plugin.settings.urlStyle = 'clean-with-redirects'

    // The same habit as the manage-folders dialog: nothing here is a draft, and
    // the redraw does not wait on the write.
    void this.plugin.saveSettings()
    new Notice(importedNotice(plan, publishedAfter, ticked.length), 8000)
    this.close()
  }
}

export interface PublishImportRowOptions {
  app: App
  container: HTMLElement
  plugin: OpenPublishPlugin
  /** Re-render the screen behind this one: an import changes what it is showing. */
  onDone: () => void
}

/**
 * Renders nothing when the vault has no `publish.json`. The whole
 * discoverability rule, in one place.
 *
 * The file is re-read when the button is pressed rather than cached with the
 * row, because it outlives an Obsidian session: somebody who edits their
 * Publish folders and comes back must not be shown a stale plan.
 */
export function renderPublishImportRow(options: PublishImportRowOptions): void {
  if (!options.plugin.hasObsidianPublishConfig()) return

  new Setting(options.container)
    .setClass('op-offer')
    .setName('Import from Obsidian Publish')
    .setDesc(
      'This vault has an Obsidian Publish configuration. The folders behind Manage publish filters can be brought ' +
        'across, and nothing is written until you have seen what they publish.',
    )
    .addButton((button) => button.setButtonText('Review import').onClick(() => void openImport(options)))
}

async function openImport(options: PublishImportRowOptions): Promise<void> {
  const raw = await options.plugin.readObsidianPublishConfig()
  if (raw === null) {
    new Notice(
      'Obsidian Publish\'s configuration could not be read. It may have been moved or deleted since Obsidian started.',
      8000,
    )
    return
  }

  const result = parsePublishConfig(raw)
  if (!result.ok) {
    new Notice(
      result.reason === 'unreadable'
        ? 'This vault\'s publish.json could not be understood. If it has been edited by hand, check that it is still valid JSON.'
        : 'This vault\'s publish.json does not look like an Obsidian Publish configuration, so there is nothing to import.',
      10000,
    )
    return
  }

  new PublishImportModal(
    options.app,
    options.plugin,
    { config: result.config, dropped: result.dropped },
    options.onDone,
  ).open()
}
