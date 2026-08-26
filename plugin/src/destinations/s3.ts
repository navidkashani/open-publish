/**
 * S3-compatible destination: SigV4 signing + the injected HTTP transport.
 *
 * Verified against Cloudflare R2 and MinIO. Path-style addressing is the
 * default because it works everywhere; virtual-host addressing is available for
 * providers that require it.
 */

import type { Destination, HeadResult, ListEntry, PutOptions, PutResult, ReadOptions, TestResult } from './types.ts'
import type { HttpClient, HttpRequest } from './http.ts'
import { header, normalizeEtag } from './http.ts'
import { EMPTY_PAYLOAD_SHA256, sha256Hex, signRequest, uriEncode } from './sigv4.ts'
import { describeStorageError, PublishError, toPublishError } from '../core/errors.ts'
import { contentTypeForPath } from './content-types.ts'

export interface S3Config {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  prefix?: string
  forcePathStyle?: boolean
}

export class S3Destination implements Destination {
  readonly id = 's3'
  private conditionalWrites = true

  private readonly config: S3Config
  private readonly http: HttpClient

  constructor(config: S3Config, http: HttpClient) {
    this.config = config
    this.http = http
  }

  describe(): string {
    const prefix = this.normalizedPrefix()
    return `${this.config.bucket}${prefix ? '/' + prefix : ''} at ${this.hostOfEndpoint()}`
  }

  supportsConditionalWrites(): boolean {
    return this.conditionalWrites
  }

  async put(key: string, body: ArrayBuffer, options: PutOptions = {}): Promise<PutResult> {
    const extraSignedHeaders: Record<string, string> = {}
    // Conditional headers must be signed: they change the meaning of the request,
    // and R2 rejects them if they are not covered by the signature.
    if (options.ifMatch) extraSignedHeaders['if-match'] = `"${options.ifMatch}"`
    if (options.ifNoneMatch) extraSignedHeaders['if-none-match'] = options.ifNoneMatch

    const response = await this.send({
      method: 'PUT',
      key,
      body,
      contentType: options.contentType ?? contentTypeForPath(key),
      extraSignedHeaders,
    })

    if (response.status === 412 || response.status === 409) {
      throw describeStorageError(412, response.text, this.errorContext(key))
    }
    if (response.status === 501 || (response.status === 400 && /not implemented|unsupported/i.test(response.text))) {
      // The provider does not do conditional writes. Record it so the publisher
      // can fall back to read-then-warn instead of silently losing the guard.
      if (options.ifMatch || options.ifNoneMatch) {
        this.conditionalWrites = false
        throw new PublishError('storage-failed', 'This storage provider does not support conditional writes.', {
          hint: 'Open Publish will fall back to a read-then-warn check on the next attempt.',
        })
      }
    }
    if (!isOk(response.status)) {
      throw describeStorageError(response.status, response.text, this.errorContext(key))
    }
    return { etag: normalizeEtag(header(response, 'etag')) }
  }

  async get(key: string, options: ReadOptions = {}): Promise<ArrayBuffer | null> {
    const response = await this.send({ method: 'GET', key, read: options })
    if (response.status === 404) return null
    if (!isOk(response.status)) {
      throw describeStorageError(response.status, response.text, this.errorContext(key))
    }
    return response.arrayBuffer
  }

  /** Returns the body together with its ETag, so a read-modify-write can use If-Match. */
  async getWithEtag(key: string, options: ReadOptions = {}): Promise<{ body: ArrayBuffer; etag?: string } | null> {
    const response = await this.send({ method: 'GET', key, read: options })
    if (response.status === 404) return null
    if (!isOk(response.status)) {
      throw describeStorageError(response.status, response.text, this.errorContext(key))
    }
    return { body: response.arrayBuffer, etag: normalizeEtag(header(response, 'etag')) }
  }

  async head(key: string, options: ReadOptions = {}): Promise<HeadResult | null> {
    const response = await this.send({ method: 'HEAD', key, read: options })
    if (response.status === 404) return null
    if (!isOk(response.status)) {
      throw describeStorageError(response.status, response.text, this.errorContext(key))
    }
    const size = Number(header(response, 'content-length') ?? '0')
    return { size: Number.isFinite(size) ? size : 0, etag: normalizeEtag(header(response, 'etag')) }
  }

  async delete(key: string): Promise<void> {
    const response = await this.send({ method: 'DELETE', key })
    // S3 returns 204 for a successful delete and for a key that was already gone.
    if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
      throw describeStorageError(response.status, response.text, this.errorContext(key))
    }
  }

  async list(prefix: string): Promise<ListEntry[]> {
    const entries: ListEntry[] = []
    let continuationToken: string | undefined

    do {
      // Not URLSearchParams: it encodes a space as `+`, while the signer reads
      // the query back through `URL.searchParams` (turning `+` into a space)
      // and re-encodes it as `%20`. The canonical request and the wire request
      // then disagree, and every list fails with SignatureDoesNotMatch, which
      // is one typed space in the prefix setting away.
      const params: Array<[string, string]> = [
        ['list-type', '2'],
        ['prefix', this.fullKey(prefix)],
        ['max-keys', '1000'],
      ]
      if (continuationToken) params.push(['continuation-token', continuationToken])
      const query = params.map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`).join('&')

      const response = await this.send({ method: 'GET', key: '', query })
      if (!isOk(response.status)) {
        throw describeStorageError(response.status, response.text, this.errorContext())
      }

      const parsed = parseListObjectsV2(response.text)
      const keyPrefix = this.normalizedPrefix()
      for (const entry of parsed.entries) {
        // Hand back keys relative to the configured prefix so callers never
        // have to know whether a prefix is in play.
        const relative = keyPrefix && entry.key.startsWith(keyPrefix + '/')
          ? entry.key.slice(keyPrefix.length + 1)
          : entry.key
        entries.push({ ...entry, key: relative })
      }
      continuationToken = parsed.nextContinuationToken
    } while (continuationToken)

    return entries
  }

  /**
   * Round-trips a small object: PUT, GET, compare, DELETE. Anything less does
   * not actually prove the token has write access to *this* bucket.
   */
  async test(): Promise<TestResult> {
    const key = '.open-publish-test'
    const payload = new TextEncoder().encode(`open-publish ${Date.now()}`)
    try {
      await this.put(key, payload.buffer as ArrayBuffer, { contentType: 'text/plain' })
      // The same key is reused every run, so a cached copy would be the *last*
      // run's payload, and the mismatch would be reported as "your storage is
      // broken" when the only thing wrong was the cache.
      const readBack = await this.get(key, { fresh: true })
      if (!readBack) {
        return { ok: false, reason: 'Wrote a test object but could not read it back.', hint: 'The token may be write-only.' }
      }
      const same = new Uint8Array(readBack).every((byte, i) => byte === payload[i])
      if (!same || readBack.byteLength !== payload.byteLength) {
        return { ok: false, reason: 'The test object read back with different contents.' }
      }
      await this.delete(key)
      return { ok: true }
    } catch (error) {
      const publishError = toPublishError(error, 'The storage test failed.')
      return { ok: false, reason: publishError.message, hint: publishError.hint }
    }
  }

  // --- internals ---------------------------------------------------------

  private normalizedPrefix(): string {
    return (this.config.prefix ?? '').replace(/^\/+|\/+$/g, '')
  }

  private fullKey(key: string): string {
    const prefix = this.normalizedPrefix()
    return prefix ? `${prefix}/${key}` : key
  }

  private hostOfEndpoint(): string {
    try {
      return new URL(this.config.endpoint).host
    } catch {
      return this.config.endpoint
    }
  }

  private buildUrl(key: string, query?: string): string {
    const endpoint = new URL(this.config.endpoint.replace(/\/+$/, ''))
    const encodedKey = key ? uriEncode(this.fullKey(key), false) : ''

    // An empty key means an operation on the bucket itself (ListObjectsV2).
    // Some S3 implementations are fussy about the trailing slash, so drop it.
    if (this.config.forcePathStyle === false) {
      endpoint.host = `${this.config.bucket}.${endpoint.host}`
      endpoint.pathname = encodedKey ? `/${encodedKey}` : '/'
    } else {
      const base = `${endpoint.pathname.replace(/\/+$/, '')}/${this.config.bucket}`
      endpoint.pathname = encodedKey ? `${base}/${encodedKey}` : base
    }
    // Assemble by hand: URL#search would re-encode the already-canonical query.
    return `${endpoint.origin}${endpoint.pathname}${query ? '?' + query : ''}`
  }

  private errorContext(key?: string) {
    return { bucket: this.config.bucket, endpoint: this.config.endpoint, key }
  }

  private async send(request: {
    method: string
    key: string
    query?: string
    body?: ArrayBuffer
    contentType?: string
    extraSignedHeaders?: Record<string, string>
    read?: ReadOptions
  }) {
    // A unique URL has nothing to be served from. `Cache-Control` alone leaves
    // room for a revalidation that some transports answer from their own store,
    // and for the site pointer "probably still current" is not good enough:
    // reading a stale one means diffing against a site that has already moved,
    // which shows edits as unpublished that are already live.
    const query = request.read?.fresh ? appendNonce(request.query) : request.query
    const url = this.buildUrl(request.key, query)
    const payloadHashHex = request.body ? await sha256Hex(request.body) : EMPTY_PAYLOAD_SHA256

    const signed = await signRequest({
      method: request.method,
      url,
      region: this.config.region || 'auto',
      service: 's3',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      payloadHashHex,
      extraSignedHeaders: request.extraSignedHeaders,
    })

    const httpRequest: HttpRequest = {
      url: signed.url,
      method: request.method,
      headers: signed.headers,
      body: request.body,
      contentType: request.contentType,
    }
    // Unsigned on purpose: SigV4 only validates the headers it names, and a
    // cache directive is not part of what the request means to the bucket.
    if (request.method === 'GET' || request.method === 'HEAD') {
      httpRequest.headers = { ...signed.headers, 'Cache-Control': 'no-cache' }
    }
    return this.http(httpRequest)
  }
}

/**
 * A signed cache-buster. It rides in the query string, so `signRequest` covers
 * it automatically. An unsigned parameter would be rejected outright.
 *
 * Not `Date.now()` alone: two reads inside the same millisecond would share a
 * URL, and that is precisely the back-to-back case this exists for.
 */
let nonceCounter = 0
function appendNonce(query?: string): string {
  const nonce = `${Date.now().toString(36)}-${(nonceCounter++).toString(36)}`
  return query ? `${query}&x-op-fresh=${nonce}` : `x-op-fresh=${nonce}`
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Minimal ListObjectsV2 reader.
 *
 * Regex rather than DOMParser: providers differ on XML namespaces, and there is
 * no DOMParser in the Node context where this module's tests run. The response
 * shape we care about is three fixed tags.
 */
export function parseListObjectsV2(xml: string): { entries: ListEntry[]; nextContinuationToken?: string } {
  const entries: ListEntry[] = []
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g
  let match: RegExpExecArray | null

  while ((match = contents.exec(xml)) !== null) {
    const block = match[1]
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1]
    if (!key) continue
    const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? '0')
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1]
    const parsedDate = modified ? Date.parse(modified) : NaN
    entries.push({
      key: decodeXmlEntities(key),
      size: Number.isFinite(size) ? size : 0,
      lastModified: Number.isFinite(parsedDate) ? parsedDate : undefined,
    })
  }

  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
  return {
    entries,
    nextContinuationToken: truncated && token ? decodeXmlEntities(token) : undefined,
  }
}
