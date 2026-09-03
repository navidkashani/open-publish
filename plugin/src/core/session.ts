/**
 * A publish that outlives the window it was started from.
 *
 * The old flow put the AbortController on the modal and aborted it in
 * `onClose()`, which meant closing the window (the natural thing to do while
 * a site takes two minutes to rebuild) silently cancelled the publish. Moving
 * the run to the plugin fixes that by construction: the window becomes a view
 * onto a session it does not own, and closing a view cancels nothing.
 *
 * The other thing this buys: reopening the window attaches to the run in
 * progress instead of starting a fresh scan.
 *
 * No Obsidian import: unit tested under plain Node.
 */

import { PublishError, toPublishError } from './errors.ts'
import type { DeployOutcome, PublishEvent, PublishOutcome, PublishPhase } from './publisher.ts'

/** Kept small on purpose: a first publish can be thousands of files. */
const MAX_LOGGED_UPLOADS = 200

export interface PublishSummary {
  /** Pages the user asked to add or update. */
  updates: number
  /** Pages the user asked to take off the site. */
  removals: number
  firstPublish: boolean
}

export interface PublishProgress {
  phase: PublishPhase
  message: string
  detail?: string
  current?: number
  total?: number
  uploadedCount: number
  skippedCount: number
  /** Capped at MAX_LOGGED_UPLOADS. */
  uploadedPaths: string[]
}

export interface SessionStatus {
  state: 'running' | 'done' | 'failed'
  /**
   * True once the notes are stored. Everything after this point is the site
   * catching up, and no failure past here is a failed publish.
   */
  committed: boolean
  /** False once there is nothing left to cancel. The button goes away rather than lying. */
  cancellable: boolean
  progress: PublishProgress
  deploy: DeployOutcome | null
  outcome: PublishOutcome | null
  error: PublishError | null
}

export type SessionListener = (status: SessionStatus) => void

export interface PublishSessionOptions {
  summary: PublishSummary
  /** Does the actual work. The session owns the signal. */
  run: (onEvent: (event: PublishEvent) => void, signal: AbortSignal) => Promise<PublishOutcome>
}

export class PublishSession {
  readonly summary: PublishSummary
  /** Always resolves: the failure is in the status, so nothing has to catch. */
  readonly finished: Promise<SessionStatus>

  private readonly controller = new AbortController()
  private readonly listeners = new Set<SessionListener>()
  private status: SessionStatus = {
    state: 'running',
    committed: false,
    cancellable: true,
    progress: {
      phase: 'preflight',
      message: 'Starting…',
      uploadedCount: 0,
      skippedCount: 0,
      uploadedPaths: [],
    },
    deploy: null,
    outcome: null,
    error: null,
  }

  constructor(options: PublishSessionOptions) {
    this.summary = options.summary
    this.finished = this.start(options.run)
  }

  /**
   * A session that cannot start is still a session that finished, badly.
   * Letting the constructor throw would leave the caller holding nothing to
   * report the failure with, so even a synchronous throw lands in the status.
   */
  private start(run: PublishSessionOptions['run']): Promise<SessionStatus> {
    try {
      return run((event) => this.handleEvent(event), this.controller.signal).then(
        (outcome) => this.settle(outcome),
        (error) => this.fail(error),
      )
    } catch (error) {
      return Promise.resolve(this.fail(error))
    }
  }

  current(): SessionStatus {
    return this.status
  }

  isRunning(): boolean {
    return this.status.state === 'running'
  }

  /**
   * Subscribe, and receive the current status straight away so a view that
   * attaches mid-run paints immediately rather than waiting for the next event.
   */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    listener(this.status)
    return () => this.listeners.delete(listener)
  }

  /**
   * Cancel, if there is still anything to cancel.
   *
   * Returns false once the notes are committed. Callers should hide the button
   * rather than call this and ignore the answer.
   */
  cancel(): boolean {
    if (!this.status.cancellable) return false
    this.controller.abort()
    return true
  }

  private handleEvent(event: PublishEvent): void {
    const progress = this.status.progress
    const next: PublishProgress = { ...progress, phase: event.phase }

    if (event.message) next.message = event.message

    // A detail line belongs to the phase that set it: it survives the events
    // that follow it in that phase (a build reports progress without repeating
    // itself) and goes when the phase does, so no stale sentence outlives it.
    if (event.detail) next.detail = event.detail
    else if (event.phase !== progress.phase) delete next.detail

    if (typeof event.current === 'number' && typeof event.total === 'number' && event.total > 0) {
      next.current = event.current
      next.total = event.total
    } else if (event.phase === 'committing' || event.phase === 'triggering' || event.phase === 'verifying') {
      delete next.current
      delete next.total
    }

    // Set, never add. Preflight resolves most files without a request and
    // reports a running total; a second preflight after a re-plan reports its
    // own total, which replaces the first rather than doubling it.
    if (typeof event.alreadyStored === 'number') next.skippedCount = event.alreadyStored

    if (event.fileDone) {
      if (event.fileDone.skipped) {
        next.skippedCount = progress.skippedCount + 1
      } else {
        next.uploadedCount = progress.uploadedCount + 1
        if (next.uploadedPaths.length < MAX_LOGGED_UPLOADS) {
          next.uploadedPaths = [...next.uploadedPaths, event.fileDone.path]
        }
      }
    }

    this.status = {
      ...this.status,
      progress: next,
      committed: this.status.committed || event.committed === true,
      cancellable: this.status.cancellable && event.committed !== true,
      deploy: event.deploy ?? this.status.deploy,
    }
    this.notify()
  }

  private settle(outcome: PublishOutcome): SessionStatus {
    this.status = {
      ...this.status,
      state: 'done',
      committed: this.status.committed || outcome.committed,
      cancellable: false,
      deploy: outcome.deploy ?? this.status.deploy,
      outcome,
    }
    this.notify()
    return this.status
  }

  private fail(error: unknown): SessionStatus {
    const publishError =
      error instanceof PublishError ? error : toPublishError(error, 'The publish could not be finished.')
    this.status = {
      ...this.status,
      state: 'failed',
      cancellable: false,
      error: publishError,
    }
    this.notify()
    return this.status
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.status)
  }
}
