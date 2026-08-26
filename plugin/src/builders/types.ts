export interface BuilderTestResult {
  ok: boolean
  reason?: string
  hint?: string
}

export interface TriggerResult {
  accepted: boolean
  /** Provider job reference, when one comes back. Informational only. */
  ref?: string
}

export type DeployState =
  | { state: 'pending'; detail?: string }
  | { state: 'live'; detail?: string }
  | { state: 'timeout'; detail?: string }

export interface Builder {
  readonly id: string
  test(): Promise<BuilderTestResult>
  trigger(snapshotId: string): Promise<TriggerResult>
  /**
   * Whether this builder can tell that a deploy landed. A hook can be set up
   * without a site address, in which case builds start but nothing can confirm
   * them, worth saying out loud rather than spinning on a poll that will never
   * succeed. Absent means yes.
   */
  canVerify?(): boolean
  waitForDeploy(
    snapshotId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): AsyncIterable<DeployState>
}
