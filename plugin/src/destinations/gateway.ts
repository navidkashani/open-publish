/**
 * The gateway destination: one bearer token, one Worker, no storage key.
 *
 * The Worker (see `gateway/` in this repository) is bound to the user's R2
 * bucket by Cloudflare, so no S3 credential exists on the device at all. This
 * class is the other half of that: the same nine methods `S3Destination`
 * implements, over a five-route JSON API instead of SigV4 and XML.
 *
 * Be precise about the claim. The token still lives in `data.json`, plain text,
 * synced, readable by every other Obsidian plugin. **This is not encryption.**
 * What it buys is blast radius: the token reaches one Worker, which reaches one
 * bucket (or one prefix of it, if the Worker sets PREFIX), and rotating it is
 * one action in one place.
 *
 * Same injected `HttpClient` as `S3Destination`, so this unit-tests against the
 * fake transport with no network and no Obsidian.
 */

import type {
  Destination,
  HeadResult,
  ListEntry,
  PutOptions,
  PutResult,
  ReadOptions,
  TestResult,
} from './types.ts'
import type { HttpClient, HttpRequest, HttpResponse } from './http.ts'
import { header, normalizeEtag } from './http.ts'
import { runConnectionTest } from './connection-test.ts'
import { PublishError, describeGatewayError } from '../core/errors.ts'
import { contentTypeForPath } from './content-types.ts'

export interface GatewayConfig {
  /** What wrangler printed on deploy, e.g. https://open-publish-gateway.you.workers.dev */
  workerUrl: string
  token: string
  /**
   * An optional *second* prefix, on top of the one the Worker enforces.
   *
   * The Worker's `PREFIX` is the security boundary and cannot be reached from
   * here. This one is the same convenience the S3 destination has: it lets one
   * gateway carry several sites. Everything below sends keys relative to the
   * Worker's prefix and receives them the same way, so the two never have to
   * know about each other.
   */
  prefix?: string
}

/** What the Worker answers `GET /l` with. */
interface ListPage {
  entries?: Array<{ key?: unknown; size?: unknown; lastModified?: unknown }>
  cursor?: unknown
}

export class GatewayDestination implements Destination {
  readonly id = 'gateway'

  private readonly config: GatewayConfig
  private readonly http: HttpClient

  constructor(config: GatewayConfig, http: HttpClient) {
    this.config = config
    this.http = http
  }

  describe(): string {
    const prefix = this.normalizedPrefix()
    return `${this.hostOfWorker()}${prefix ? '/' + prefix : ''}`
  }

  /**
   * Always true, and not a field that can be turned off.
   *
   * The Worker is ours and R2 supports conditional writes, so there is no
   * "this provider never implemented it" case to degrade into. A gateway that
   * nonetheless ignored a condition is still caught, by the probe in
   * `runConnectionTest`, which reports it as `ignored` rather than as a
   * capability that was never there.
   */
  supportsConditionalWrites(): boolean {
    return true
  }

  async put(key: string, body: ArrayBuffer, options: PutOptions = {}): Promise<PutResult> {
    const headers: Record<string, string> = {}
    // Quoted, because these go to R2 as HTTP conditional headers and that is
    // what an entity-tag looks like. `*` is the one form that is never quoted.
    if (options.ifMatch) headers['If-Match'] = `"${options.ifMatch}"`
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch

    const response = await this.send({
      method: 'PUT',
      path: this.objectPath(key),
      body,
      contentType: options.contentType ?? contentTypeForPath(key),
      headers,
    })

    if (response.status === 412 || response.status === 409) {
      throw describeGatewayError(412, response.text, this.errorContext(key))
    }
    if (!isOk(response.status)) {
      throw describeGatewayError(response.status, response.text, this.errorContext(key))
    }
    return { etag: normalizeEtag(header(response, 'etag')) }
  }

  async get(key: string, options: ReadOptions = {}): Promise<ArrayBuffer | null> {
    const response = await this.send({ method: 'GET', path: this.objectPath(key), read: options })
    if (response.status === 404) return this.missing(response)
    if (!isOk(response.status)) {
      throw describeGatewayError(response.status, response.text, this.errorContext(key))
    }
    return response.arrayBuffer
  }

  /** Returns the body together with its ETag, so a read-modify-write can use If-Match. */
  async getWithEtag(key: string, options: ReadOptions = {}): Promise<{ body: ArrayBuffer; etag?: string } | null> {
    const response = await this.send({ method: 'GET', path: this.objectPath(key), read: options })
    if (response.status === 404) return this.missing(response)
    if (!isOk(response.status)) {
      throw describeGatewayError(response.status, response.text, this.errorContext(key))
    }
    return { body: response.arrayBuffer, etag: normalizeEtag(header(response, 'etag')) }
  }

  async head(key: string, options: ReadOptions = {}): Promise<HeadResult | null> {
    const response = await this.send({ method: 'HEAD', path: this.objectPath(key), read: options })
    if (response.status === 404) return this.missing(response)
    if (!isOk(response.status)) {
      throw describeGatewayError(response.status, response.text, this.errorContext(key))
    }
    const size = Number(header(response, 'content-length') ?? '0')
    return { size: Number.isFinite(size) ? size : 0, etag: normalizeEtag(header(response, 'etag')) }
  }

  async delete(key: string): Promise<void> {
    const response = await this.send({ method: 'DELETE', path: this.objectPath(key) })
    // 204 is the answer, and 404 is the same state arrived at earlier.
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw describeGatewayError(response.status, response.text, this.errorContext(key))
    }
  }

  async list(prefix: string): Promise<ListEntry[]> {
    const entries: ListEntry[] = []
    const keyPrefix = this.normalizedPrefix()
    let cursor: string | undefined

    do {
      // URLSearchParams is safe here in a way it is not on the S3 path: nothing
      // is signed, so there is no canonical form for the encoding to disagree
      // with.
      const params = new URLSearchParams({ prefix: this.fullKey(prefix) })
      if (cursor) params.set('cursor', cursor)

      const response = await this.send({ method: 'GET', path: `/l?${params.toString()}` })
      if (!isOk(response.status)) {
        throw describeGatewayError(response.status, response.text, this.errorContext())
      }

      const page = this.parseListPage(response.text)
      for (const entry of page.entries ?? []) {
        if (typeof entry.key !== 'string') continue
        // Relative to *our* prefix. The Worker has already stripped its own, so
        // callers never have to know that either is in play.
        const relative =
          keyPrefix && entry.key.startsWith(keyPrefix + '/') ? entry.key.slice(keyPrefix.length + 1) : entry.key
        const size = Number(entry.size)
        const lastModified = Number(entry.lastModified)
        entries.push({
          key: relative,
          size: Number.isFinite(size) ? size : 0,
          ...(Number.isFinite(lastModified) ? { lastModified } : {}),
        })
      }
      cursor = typeof page.cursor === 'string' && page.cursor ? page.cursor : undefined
    } while (cursor)

    return entries
  }

  async test(): Promise<TestResult> {
    return runConnectionTest(this, Date.now())
  }

  // --- internals ---------------------------------------------------------

  private normalizedPrefix(): string {
    return (this.config.prefix ?? '').replace(/^\/+|\/+$/g, '')
  }

  private fullKey(key: string): string {
    const prefix = this.normalizedPrefix()
    return prefix ? `${prefix}/${key}` : key
  }

  private hostOfWorker(): string {
    try {
      return new URL(this.config.workerUrl).host
    } catch {
      return this.config.workerUrl
    }
  }

  /**
   * Percent-encoded segment by segment, so a `/` in a key stays a path
   * separator and everything else that could change the URL's meaning does not.
   */
  private objectPath(key: string): string {
    return `/o/${this.fullKey(key).split('/').map(encodeURIComponent).join('/')}`
  }

  private errorContext(key?: string) {
    return { worker: this.config.workerUrl, key }
  }

  /**
   * A 404, and whether it means what a 404 normally means here.
   *
   * "This key is not in the bucket" is an ordinary answer on the publish path,
   * and the caller wants null for it. "Nothing at this address knows what /o/
   * is" is a wrong Worker address, and answering null for *that* is the worst
   * shape of wrong: `scanner.ts` reads a null pointer as "nothing has ever been
   * published", shows the entire vault as unpublished, and the real cause
   * surfaces later as a failed PUT, three screens from the field that caused
   * it.
   *
   * The Worker marks the first kind specifically. The signature header is not
   * enough on its own: it says a gateway answered, and a gateway is exactly
   * what answers 404 when its address carries a path its routes do not serve,
   * which is the shape of a mistyped or re-routed Worker address.
   */
  private missing(response: HttpResponse): null {
    if (header(response, 'x-open-publish-miss') === 'key') return null
    throw describeGatewayError(404, response.text, this.errorContext())
  }

  private async send(request: {
    method: string
    path: string
    body?: ArrayBuffer
    contentType?: string
    headers?: Record<string, string>
    read?: ReadOptions
  }) {
    const base = this.config.workerUrl.trim().replace(/\/+$/, '')
    const path = request.read?.fresh ? appendNonce(request.path) : request.path

    const httpRequest: HttpRequest = {
      url: `${base}${path}`,
      method: request.method,
      headers: { Authorization: `Bearer ${this.config.token}`, ...request.headers },
      body: request.body,
      contentType: request.contentType,
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      httpRequest.headers = { ...httpRequest.headers, 'Cache-Control': 'no-cache' }
    }
    return this.http(httpRequest)
  }

  /**
   * A malformed page is a failure with a sentence, never a raw SyntaxError.
   *
   * Not routed through `describeGatewayError`: the request succeeded, so every
   * sentence in that table is about the wrong thing. Something answered 200
   * with a body a gateway would not send, and the likeliest cause by far is
   * that the address points at something else.
   */
  private parseListPage(text: string): ListPage {
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      return parsed as ListPage
    } catch {
      throw new PublishError('storage-failed', 'The Worker answered with something that is not a listing.', {
        hint: `Check that ${this.config.workerUrl} is your Open Publish gateway and not another Worker.`,
      })
    }
  }
}

/**
 * A cache-buster for the reads that must be a round trip.
 *
 * `Cache-Control` alone leaves room for a revalidation that some transports
 * answer from their own store, and for the site pointer "probably still
 * current" is not good enough: reading a stale one means diffing against a site
 * that has already moved, which shows edits as unpublished that are already
 * live. A unique URL has nothing to be served from.
 *
 * Not `Date.now()` alone: two reads inside the same millisecond would share a
 * URL, and that is precisely the back-to-back case this exists for.
 */
let nonceCounter = 0
function appendNonce(path: string): string {
  const nonce = `${Date.now().toString(36)}-${(nonceCounter++).toString(36)}`
  return `${path}${path.includes('?') ? '&' : '?'}x-op-fresh=${nonce}`
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300
}
