/**
 * Deploy-hook builder.
 *
 * Design note 2.4: deploy hooks return a job ID at best, and no provider gives
 * neutral build status without more credentials. So instead of asking the
 * provider, we ask the site: the starter writes `/_publish.json` containing the
 * snapshot ID it built, and we poll the live URL until that ID matches.
 * Provider-neutral, zero extra credentials, works on Pages, Workers, Netlify
 * and Vercel alike.
 */

import type { Builder, BuilderTestResult, DeployState, TriggerResult } from './types.ts'
import type { HttpClient } from '../destinations/http.ts'
import { describeHookError, toPublishError } from '../core/errors.ts'

export interface WebhookConfig {
  url: string
  method: 'POST' | 'GET'
  siteUrl: string
  logsUrl?: string
}

export const PUBLISH_MARKER_PATH = '_publish.json'

export interface PublishMarker {
  snapshot: string
  builtAt?: number
}

export class WebhookBuilder implements Builder {
  readonly id = 'webhook'

  private readonly config: WebhookConfig
  private readonly http: HttpClient
  /** Injectable for tests; production passes a real sleep. */
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    config: WebhookConfig,
    http: HttpClient,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.config = config
    this.http = http
    this.sleep = sleep
  }

  async trigger(snapshotId: string): Promise<TriggerResult> {
    let response
    try {
      response = await this.http({
        url: this.config.url,
        method: this.config.method,
        // Some providers ignore the body entirely; those that log it get something useful.
        body: this.config.method === 'POST' ? JSON.stringify({ snapshot: snapshotId }) : undefined,
        contentType: this.config.method === 'POST' ? 'application/json' : undefined,
      })
    } catch (error) {
      throw toPublishError(error, 'Could not reach the deploy hook.')
    }

    if (response.status < 200 || response.status >= 300) {
      throw describeHookError(response.status)
    }

    let ref: string | undefined
    try {
      const parsed = JSON.parse(response.text) as Record<string, unknown>
      const candidate = parsed['id'] ?? parsed['deploy_id'] ?? (parsed['result'] as Record<string, unknown> | undefined)?.['id']
      if (typeof candidate === 'string') ref = candidate
    } catch {
      // Most hooks return an empty body. That is fine.
    }
    return { accepted: true, ref }
  }

  /** Without a site address there is nothing to poll, so nothing to confirm. */
  canVerify(): boolean {
    return Boolean(this.config.siteUrl)
  }

  /**
   * Checks that the site URL is reachable and, if the site has already been
   * built once, that `_publish.json` is being served. It deliberately does NOT
   * trigger a build: free-tier build allowances are small enough that a "test"
   * button should not spend one without the user asking.
   */
  async test(): Promise<BuilderTestResult> {
    if (!this.config.url) return { ok: false, reason: 'No deploy hook URL is set.' }
    if (!this.config.siteUrl) return { ok: false, reason: 'No site URL is set.' }

    try {
      new URL(this.config.url)
      new URL(this.config.siteUrl)
    } catch {
      return { ok: false, reason: 'The deploy hook URL or site URL is not a valid URL.' }
    }

    try {
      const response = await this.http({ url: this.markerUrl(), method: 'GET' })
      if (response.status === 404) {
        return {
          ok: true,
          reason: 'The site is reachable but has not been built by Open Publish yet.',
          hint: 'That is expected before your first publish.',
        }
      }
      if (response.status >= 200 && response.status < 300) {
        const marker = parseMarker(response.text)
        return marker
          ? { ok: true, reason: `Site is live, currently serving snapshot ${marker.snapshot}.` }
          : { ok: false, reason: '/_publish.json exists but is not valid JSON.', hint: 'Check the starter version.' }
      }
      return { ok: false, reason: `The site URL returned HTTP ${response.status}.`, hint: 'Check the site URL.' }
    } catch (error) {
      const publishError = toPublishError(error, 'Could not reach the site URL.')
      return { ok: false, reason: publishError.message, hint: publishError.hint }
    }
  }

  async *waitForDeploy(
    snapshotId: string,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): AsyncIterable<DeployState> {
    const deadline = Date.now() + options.timeoutMs
    let attempt = 0

    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        yield { state: 'timeout', detail: 'Cancelled.' }
        return
      }

      attempt++
      try {
        const response = await this.http({ url: this.markerUrl(), method: 'GET' })
        if (response.status >= 200 && response.status < 300) {
          const marker = parseMarker(response.text)
          if (marker?.snapshot === snapshotId) {
            yield { state: 'live' }
            return
          }
          yield {
            state: 'pending',
            detail: marker ? `Site still serving ${marker.snapshot}` : 'Waiting for the build to finish',
          }
        } else {
          yield { state: 'pending', detail: `Site returned HTTP ${response.status}` }
        }
      } catch {
        // Mid-deploy blips are normal; keep polling until the deadline.
        yield { state: 'pending', detail: 'Site not responding yet' }
      }

      // Back off from 3s to 15s so a slow build does not mean hundreds of requests.
      const delay = Math.min(15000, 3000 + attempt * 1000)
      await this.sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
    }

    yield { state: 'timeout' }
  }

  /**
   * Cache-busting query parameter.
   *
   * The starter also ships a `_headers` rule setting `Cache-Control: no-store`
   * on this path, but belt and braces: a CDN serving a cached marker would make
   * us report a stale snapshot as live, which is exactly the wrong direction to
   * be wrong in.
   */
  private markerUrl(): string {
    const base = this.config.siteUrl.replace(/\/+$/, '')
    const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    return `${base}/${PUBLISH_MARKER_PATH}?t=${nonce}`
  }
}

export function parseMarker(text: string): PublishMarker | null {
  try {
    const parsed = JSON.parse(text) as Partial<PublishMarker>
    return typeof parsed.snapshot === 'string' ? { snapshot: parsed.snapshot, builtAt: parsed.builtAt } : null
  } catch {
    return null
  }
}
