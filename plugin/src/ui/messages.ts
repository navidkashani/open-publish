/**
 * Every sentence the publish window can say, in one table.
 *
 * Three rules, and they are the whole reason this file exists rather than
 * strings scattered through the views:
 *
 *  1. Plain words. No "snapshot", "commit", "hook", "quota", "compare-and-swap".
 *     Those are our concepts, not the reader's.
 *  2. Buttons are verbs. "Visit site", not "OK".
 *  3. Once the notes are saved, never say "failed". They *are* published. What
 *     failed is the site update. Saying "failed" makes people republish, and
 *     republishing fixes nothing.
 *
 * No Obsidian import, no DOM: this maps state to words and is unit tested under
 * plain Node.
 */

import type { PublishErrorCode } from '../core/errors.ts'
import type { DeployOutcome } from '../core/publisher.ts'
import { extensionOf } from '../core/selection.ts'
import type { PublishSummary, SessionStatus } from '../core/session.ts'

export type ActionId =
  | 'close'
  | 'done'
  | 'cancel'
  | 'visit-site'
  | 'open-logs'
  | 'open-settings'
  | 'finish-setup'
  | 'manage-folders'
  | 'update-now'
  | 'try-again'
  | 'rescan'

export interface MessageAction {
  label: string
  id: ActionId
  /** The one the reader most likely wants. At most one per message. */
  primary?: boolean
}

export type MessageTone = 'info' | 'ok' | 'warning' | 'error'

export interface PublishMessage {
  headline: string
  /** What actually happened, in counts. Omitted when there is nothing to count. */
  stats?: string
  /** What it means and what happens next. */
  body?: string
  buttons: MessageAction[]
  tone: MessageTone
}

/** How much of the run has happened, and what the user asked for. */
export type PublishState =
  /** `nothing-selected` is the fresh-install case: not "already matching", just empty. */
  | { kind: 'nothing-to-publish'; reason?: 'nothing-selected' }
  /**
   * The publish window's own version of "nothing to publish".
   *
   * A separate kind rather than a widened `nothing-to-publish` on purpose: that
   * one is also how a finished session with no commit and the status bar read
   * themselves, and neither of those has a site to visit or a build to start.
   */
  | { kind: 'up-to-date'; stats: string; canVisit: boolean; canRebuild: boolean }
  | { kind: 'publishing'; firstPublish: boolean }
  | { kind: 'published'; deploy: DeployOutcome; updates: number; removals: number; uploaded: number }
  | { kind: 'failed'; code: PublishErrorCode; message: string; hint?: string }

export function publishMessage(state: PublishState): PublishMessage {
  switch (state.kind) {
    case 'nothing-to-publish':
      return {
        headline: 'Nothing to publish',
        body:
          state.reason === 'nothing-selected'
            ? 'No notes are marked for publishing yet. Choose folders to publish, or put publish: true at the top of a note.'
            : 'Your site already matches your notes.',
        buttons: [{ label: 'Close', id: 'close', primary: true }],
        tone: 'info',
      }
    case 'up-to-date':
      return {
        headline: 'Your site is up to date',
        stats: state.stats,
        // Every one of these is conditional, because a button that cannot work
        // is worse than no button: it turns a calm screen into a dead end you
        // have to test by clicking.
        buttons: [
          ...(state.canRebuild ? [{ label: 'Rebuild site', id: 'update-now' } as const] : []),
          ...(state.canVisit ? [{ label: 'Visit site', id: 'visit-site', primary: true } as const] : []),
          { label: 'Close', id: 'close' },
        ],
        tone: 'info',
      }
    case 'publishing':
      return {
        headline: 'Publishing…',
        body: state.firstPublish
          ? 'Sending everything for the first time. Later publishes only send what you changed.'
          : undefined,
        buttons: [{ label: 'Cancel', id: 'cancel' }],
        tone: 'info',
      }
    case 'published':
      return publishedMessage(state)
    case 'failed':
      return failedMessage(state)
  }
}

/**
 * Read a running or finished session as one of the rows above.
 *
 * The ordering is the interesting part. `committed` is checked first and wins
 * over `error`, because once the notes are stored there is no failure left to
 * report, only a site that has or has not caught up yet. That is rule 3, in
 * code.
 */
export function stateForSession(status: SessionStatus, summary: PublishSummary): PublishState {
  if (status.committed) {
    // A site update whose fate we never learned (the app was closing, the poll
    // threw) is "still waiting", never "failed".
    const deploy: DeployOutcome | null =
      status.deploy ?? (status.state === 'running' ? null : { kind: 'timeout' })
    if (deploy) {
      return {
        kind: 'published',
        deploy,
        updates: summary.updates,
        removals: summary.removals,
        uploaded: status.progress.uploadedCount,
      }
    }
  }
  if (status.error) {
    return { kind: 'failed', code: status.error.code, message: status.error.message, hint: status.error.hint }
  }
  if (status.state === 'done') return { kind: 'nothing-to-publish' }
  return { kind: 'publishing', firstPublish: summary.firstPublish }
}

function publishedMessage(state: {
  deploy: DeployOutcome
  updates: number
  removals: number
  uploaded: number
}): PublishMessage {
  const stats = describeWhatHappened(state)
  const removalsOnly = state.removals > 0 && state.updates === 0
  const updating = removalsOnly
    ? "It's updating now. It'll be live in a minute or two. You can close this window."
    : "Your site is updating now. It'll be live in a minute or two. You can close this window."

  switch (state.deploy.kind) {
    case 'requested':
      return {
        headline: 'Published',
        stats,
        body: updating,
        buttons: [
          { label: 'Visit site', id: 'visit-site', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'ok',
      }
    case 'live':
      return {
        headline: 'Your site is live',
        stats,
        buttons: [
          { label: 'Visit site', id: 'visit-site', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'ok',
      }
    case 'unverifiable':
      return {
        headline: 'Published',
        stats,
        body: 'Your notes are saved. Add your site address in settings and we can tell you when updates go live.',
        buttons: [
          { label: 'Open settings', id: 'open-settings', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'ok',
      }
    case 'auto-off':
      return {
        headline: 'Saved, not yet live',
        stats,
        body: 'Your notes are saved. Your site will show them the next time it updates.',
        buttons: [
          { label: 'Update site now', id: 'update-now', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'info',
      }
    case 'throttled':
      return {
        headline: 'Saved, updating shortly',
        stats,
        body: `Your site updated ${minutes(state.deploy.agoMinutes)} ago. The next update waits a few minutes so you don't run out.`,
        buttons: [
          { label: 'Update now anyway', id: 'update-now', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'info',
      }
    case 'not-configured':
      return {
        headline: "Saved, but your site won't update",
        stats,
        body: "Open Publish doesn't know how to reach your site yet.",
        buttons: [
          { label: 'Finish setup', id: 'finish-setup', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'warning',
      }
    case 'rejected':
      return {
        headline: "Saved, but your site didn't update",
        stats,
        // Two causes, and naming only the first one used to send people off to
        // recreate a working connection. "Build allowance" rather than the
        // obvious word, per this file's own rule about jargon.
        body:
          "Your notes are safe and don't need uploading again. Your host turned down the request to update " +
          'your site. Either the connection to your host was removed, or this month\'s build allowance is used up.',
        buttons: [
          { label: 'Try again', id: 'update-now', primary: true },
          { label: 'Fix in settings', id: 'open-settings' },
        ],
        tone: 'warning',
      }
    case 'timeout':
      return {
        headline: 'Saved, still waiting',
        stats,
        body: 'Your notes are stored and your old site is still live. The update is taking longer than usual.',
        buttons: [
          { label: 'Open build logs', id: 'open-logs', primary: true },
          { label: 'Done', id: 'done' },
        ],
        tone: 'warning',
      }
  }
}

function failedMessage(state: { code: PublishErrorCode; message: string; hint?: string }): PublishMessage {
  switch (state.code) {
    case 'aborted':
      return {
        headline: 'Publish cancelled',
        body: 'Your site is unchanged.',
        buttons: [{ label: 'Close', id: 'close', primary: true }],
        tone: 'info',
      }
    case 'storage-unreachable':
      return {
        headline: "Can't reach your storage",
        body: 'Check your connection and try again. Nothing was changed.',
        buttons: [
          { label: 'Try again', id: 'try-again', primary: true },
          { label: 'Close', id: 'close' },
        ],
        tone: 'error',
      }
    case 'storage-credentials':
      return {
        // Both halves come from the error rather than from here, because one
        // code now covers two very different things: an S3 key pair and a
        // gateway token. Telling somebody holding a token that their keys may
        // be "for a different bucket" sends them to look for a setting that
        // does not exist on their screen.
        headline: 'Storage rejected your details',
        body: detailOf(state),
        buttons: [
          { label: 'Open settings', id: 'open-settings', primary: true },
          { label: 'Close', id: 'close' },
        ],
        tone: 'error',
      }
    case 'storage-conflict':
      return {
        headline: 'Someone else published',
        body: 'Another device published while you were working. Nothing was overwritten.',
        buttons: [
          { label: 'See what changed', id: 'rescan', primary: true },
          { label: 'Close', id: 'close' },
        ],
        tone: 'warning',
      }
    case 'not-configured':
      return {
        headline: 'Open Publish is not set up yet',
        body: state.hint ?? 'Add your storage details and we can publish.',
        buttons: [
          { label: 'Finish setup', id: 'finish-setup', primary: true },
          { label: 'Close', id: 'close' },
        ],
        tone: 'warning',
      }
    default:
      return {
        headline: "Couldn't publish",
        body: `Your site is unchanged. Whatever uploaded is kept, so trying again is quick.\n${detailOf(state)}`,
        buttons: [
          { label: 'Try again', id: 'try-again', primary: true },
          { label: 'Close', id: 'close' },
        ],
        tone: 'error',
      }
  }
}

/**
 * "1 note updated · 1 file uploaded".
 *
 * Counts what the reader asked for, not what the machine did. `uploaded` is
 * the exception, and it earns its place because it is the part that took the
 * time.
 */
function describeWhatHappened(state: { updates: number; removals: number; uploaded: number }): string | undefined {
  const parts: string[] = []
  if (state.updates > 0) parts.push(`${state.updates} ${plural(state.updates, 'note')} updated`)
  if (state.removals > 0) parts.push(`${state.removals} ${plural(state.removals, 'page')} taken off your site`)
  if (state.uploaded > 0) parts.push(`${state.uploaded} ${plural(state.uploaded, 'file')} uploaded`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

function detailOf(state: { message: string; hint?: string }): string {
  return state.hint ? `${state.message} ${state.hint}` : state.message
}

/**
 * "6 notes and 2 attachments published · 25 Aug 2026, 12:29".
 *
 * The one number worth showing on a screen where nothing is about to happen:
 * it is the difference between "up to date" and "up to date, and here is the
 * size of the thing that is up to date".
 *
 * `publishedAt` arrives already formatted. Turning a timestamp into words is
 * locale work, and doing it here would make this module (and its tests)
 * depend on the machine they run on.
 */
export function upToDateStats(paths: readonly string[], publishedAt?: string): string {
  let notes = 0
  let attachments = 0
  for (const path of paths) {
    if (extensionOf(path) === 'md') notes++
    else attachments++
  }

  const counted: string[] = []
  if (notes > 0) counted.push(`${notes} ${plural(notes, 'note')}`)
  if (attachments > 0) counted.push(`${attachments} ${plural(attachments, 'attachment')}`)
  const published = counted.length > 0 ? `${counted.join(' and ')} published` : 'Nothing published'

  return publishedAt ? `${published} · ${publishedAt}` : published
}

// --- the review screen ------------------------------------------------------

/** Above this many removals, publishing takes a second click. */
export const REMOVAL_CONFIRM_THRESHOLD = 5

/**
 * "Publish 1 change", "Publish 2 changes and 1 removal".
 *
 * Never a raw file count: the number of files touched is an implementation
 * detail, and quoting it is what made the old window read as though it were
 * re-uploading the whole vault.
 */
export function publishButtonLabel(counts: { changes: number; removals: number }): string {
  const bits: string[] = []
  if (counts.changes > 0) bits.push(`${counts.changes} ${plural(counts.changes, 'change')}`)
  if (counts.removals > 0) bits.push(`${counts.removals} ${plural(counts.removals, 'removal')}`)
  if (bits.length === 0) return 'Publish'
  return `Publish ${bits.join(' and ')}`
}

export function removalConfirmLabel(removals: number): string {
  return `This takes ${removals} ${plural(removals, 'page')} off your site. Publish anyway?`
}

export function needsRemovalConfirm(removals: number): boolean {
  return removals > REMOVAL_CONFIRM_THRESHOLD
}

/**
 * The second click.
 *
 * A mistyped exclude rule can take a hundred pages down in one press, and
 * putting them back is a rule change plus another publish. One extra click is
 * cheap insurance, but only when the number is big enough to be a surprise,
 * because a confirmation on every removal is a confirmation nobody reads.
 *
 * Any tick disarms it: the number on the button no longer describes what is on
 * screen, so agreeing to the old number would be agreeing to nothing.
 */
export class RemovalGuard {
  private armed = false

  /** True when the publish should go ahead; false when this click only asked. */
  confirm(removals: number): boolean {
    if (this.armed || !needsRemovalConfirm(removals)) {
      this.armed = false
      return true
    }
    this.armed = true
    return false
  }

  reset(): void {
    this.armed = false
  }

  isArmed(): boolean {
    return this.armed
  }
}

/** "1 changed · 2 new · 3 removed" */
export function reviewSummary(counts: {
  changed: number
  added: number
  removed: number
  renamed?: number
}): string {
  const parts: string[] = []
  if (counts.changed > 0) parts.push(`${counts.changed} changed`)
  if (counts.added > 0) parts.push(`${counts.added} new`)
  if (counts.renamed) parts.push(`${counts.renamed} renamed`)
  if (counts.removed > 0) parts.push(`${counts.removed} removed`)
  return parts.length > 0 ? parts.join(' · ') : 'no changes'
}

/** Short enough for a status bar, and it has to make sense with no window open. */
export function statusBarLabel(state: PublishState): string {
  switch (state.kind) {
    case 'publishing':
      return 'Publishing…'
    case 'published':
      return state.deploy.kind === 'requested' ? 'Site updating…' : publishMessage(state).headline
    case 'failed':
      return publishMessage(state).headline
    case 'nothing-to-publish':
      return 'Nothing to publish'
    case 'up-to-date':
      return publishMessage(state).headline
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function minutes(count: number): string {
  if (count < 1) return 'less than a minute'
  return `${count} ${plural(count, 'minute')}`
}
