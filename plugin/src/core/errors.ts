/**
 * Human-readable failures. The rule from the design review: never show a bare
 * HTTP status code. Every error the user can hit has a sentence that says what
 * broke and what to change.
 */

import { missingBucketHint } from '../destinations/providers.ts'
import { rejectedHookHint } from '../builders/hosts.ts'

export type PublishErrorCode =
  | 'storage-credentials'
  | 'storage-missing-bucket'
  | 'storage-unreachable'
  | 'storage-conflict'
  | 'storage-failed'
  | 'hook-rejected'
  | 'hook-failed'
  | 'verify-timeout'
  | 'content-too-large'
  | 'slug-collision'
  | 'too-many-files'
  | 'aborted'
  | 'not-configured'

export class PublishError extends Error {
  readonly code: PublishErrorCode
  readonly hint?: string
  readonly detail?: unknown

  constructor(code: PublishErrorCode, message: string, options: { hint?: string; detail?: unknown } = {}) {
    super(message)
    this.name = 'PublishError'
    this.code = code
    this.hint = options.hint
    this.detail = options.detail
  }

  /** Single-line rendering for Notices and log lines. */
  toDisplayString(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message
  }
}

export interface StorageErrorContext {
  bucket: string
  endpoint: string
  key?: string
}

/** Pull `<Code>…</Code>` out of an S3 XML error body, if there is one. */
export function parseS3ErrorCode(body: string | undefined): string | undefined {
  if (!body) return undefined
  const match = /<Code>([^<]+)<\/Code>/.exec(body)
  return match?.[1]
}

/**
 * Maps a storage response onto the error table from the design review.
 * `status` 0 means the request never got a response at all.
 */
export function describeStorageError(
  status: number,
  body: string | undefined,
  context: StorageErrorContext,
): PublishError {
  const s3Code = parseS3ErrorCode(body)

  if (status === 0) {
    // `body` carries the transport's own message here. Showing it is the
    // difference between "check your network" and knowing what actually broke.
    const detail = body?.trim()
    return new PublishError('storage-unreachable', `Couldn't reach the storage endpoint at ${context.endpoint}.`, {
      hint: detail
        ? `Check the endpoint URL, and that you are online. The connection reported: ${detail}`
        : 'Check the endpoint URL, and that you are online.',
      detail,
    })
  }

  if (s3Code === 'NoSuchBucket' || (status === 404 && !context.key)) {
    // The hint used to name R2 whatever the endpoint was, so an AWS user with a
    // region mismatch got advice about a product they do not use. The context
    // already carries the endpoint, so saying the right thing costs nothing.
    return new PublishError('storage-missing-bucket', `Bucket "${context.bucket}" was not found at this endpoint.`, {
      hint: missingBucketHint(context.endpoint),
    })
  }

  if (status === 403 || status === 401 || s3Code === 'SignatureDoesNotMatch' || s3Code === 'InvalidAccessKeyId') {
    return new PublishError('storage-credentials', 'Storage rejected these credentials.', {
      hint: 'They may be wrong, revoked, or scoped to a different bucket.',
    })
  }

  if (status === 412 || s3Code === 'PreconditionFailed') {
    return new PublishError('storage-conflict', 'The site pointer changed while this publish was running.', {
      hint: 'Another device published in the meantime. Re-scan and publish again.',
    })
  }

  const codePart = s3Code ? ` (${s3Code})` : ''
  return new PublishError(
    'storage-failed',
    `Storage returned an unexpected error${codePart} for ${context.key ?? context.bucket}.`,
    { hint: `HTTP ${status}. If this persists, check the bucket's permissions.` },
  )
}

export interface GatewayErrorContext {
  /** The Worker's address, as configured. */
  worker: string
  key?: string
}

/** The `{"error": "…"}` a gateway answers failures with. */
export function parseGatewayErrorMessage(body: string | undefined): string | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    return typeof parsed.error === 'string' ? parsed.error : undefined
  } catch {
    return undefined
  }
}

/**
 * The same table as `describeStorageError`, in the gateway's terms.
 *
 * Separate rather than shared because the same status means something
 * different here, and saying the S3 sentence would send people to the wrong
 * screen. A 401 is not "storage rejected these credentials, check the token is
 * scoped to this bucket": there is no bucket scope to check, only one token
 * that either matches the Worker's or does not. A 404 is not a missing bucket:
 * the Worker holds the bucket name, so a 404 means the *address* is wrong.
 *
 * The codes are the existing ones, because everything downstream branches on
 * them: `publisher.ts` refuses to retry `storage-credentials`, and
 * `messages.ts` already knows how to render each one.
 */
export function describeGatewayError(
  status: number,
  body: string | undefined,
  context: GatewayErrorContext,
): PublishError {
  const reported = parseGatewayErrorMessage(body)

  if (status === 0) {
    const detail = body?.trim()
    return new PublishError('storage-unreachable', `Couldn't reach the Worker at ${context.worker}.`, {
      hint: detail
        ? `Check the Worker address, and that you are online. The connection reported: ${detail}`
        : 'Check the Worker address, and that you are online.',
      detail,
    })
  }

  if (status === 401 || status === 403) {
    return new PublishError('storage-credentials', 'The Worker rejected this token.', {
      hint: "Check the token matches the one you set on the Worker. Run `wrangler secret put TOKEN` to set a new one, and paste the same value here.",
    })
  }

  if (status === 404) {
    // Only route-level 404s get here. A missing *key* is a normal answer and
    // is turned into null before anything asks for a sentence.
    return new PublishError('storage-missing-bucket', 'That address answered, but it is not an Open Publish gateway.', {
      hint: 'Check the Worker address. It should be the one wrangler printed when you deployed the gateway.',
    })
  }

  if (status === 412) {
    return new PublishError('storage-conflict', 'The site pointer changed while this publish was running.', {
      hint: 'Another device published in the meantime. Re-scan and publish again.',
    })
  }

  if (status === 400) {
    // Reachable from the settings screen, not only from a bug: the Worker
    // refuses a key containing ".." or a backslash, and the Key prefix field is
    // typed by hand. Blaming Open Publish would send somebody off to file an
    // issue about a field they can fix in ten seconds.
    return new PublishError('storage-failed', reported ?? 'The Worker refused that request.', {
      hint: 'Check the key prefix under Storage > Advanced. It cannot contain ".." or a backslash.',
    })
  }

  return new PublishError('storage-failed', `The Worker returned an unexpected error for ${context.key ?? '/'}.`, {
    hint: reported ? `HTTP ${status}. It reported: ${reported}` : `HTTP ${status}. Check the Worker's logs in the Cloudflare dashboard.`,
  })
}

/**
 * `url` is the hook URL, and the host is inferred from it rather than passed
 * in, exactly as `missingBucketHint` infers a provider from the endpoint. That
 * keeps the URL the single source of truth and keeps the host id out of
 * `WebhookConfig`, which never learns one exists.
 *
 * The reason it matters: Netlify answers a build hook with an error once the
 * month's allowance is gone, and does not document which status. If it is 403,
 * the old sentence sent that user off to recreate a deploy hook that was
 * working perfectly.
 */
export function describeHookError(status: number, url?: string): PublishError {
  if (status === 401 || status === 403 || status === 404) {
    return new PublishError('hook-rejected', 'The deploy hook was rejected.', {
      hint: rejectedHookHint(url),
    })
  }
  if (status === 0) {
    return new PublishError('hook-failed', "Couldn't reach the deploy hook URL.", {
      hint: 'Check the URL, and that you are online.',
    })
  }
  return new PublishError('hook-failed', `The deploy hook returned an unexpected error (HTTP ${status}).`, {
    hint: 'Your content is already published; only the build was not started.',
  })
}

export function verifyTimeoutError(logsUrl?: string): PublishError {
  return new PublishError('verify-timeout', "Uploaded successfully, but the site hasn't updated yet.", {
    hint: logsUrl ? `Open the build logs: ${logsUrl}` : "Check your host's build logs.",
  })
}

/** Anything thrown by a transport, rendered as a sentence rather than a stack. */
export function toPublishError(error: unknown, fallbackMessage: string): PublishError {
  if (error instanceof PublishError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ERR_NAME_NOT_RESOLVED|net::ERR_NAME/i.test(message)) {
    return new PublishError('storage-unreachable', "Couldn't resolve the endpoint host name.", {
      hint: 'Check the endpoint URL for typos.',
      detail: message,
    })
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|net::ERR_/i.test(message)) {
    return new PublishError('storage-unreachable', 'The network connection failed.', {
      hint: 'Check your connection and try again. Publishing is safe to retry.',
      detail: message,
    })
  }
  return new PublishError('storage-failed', fallbackMessage, { hint: message, detail: message })
}
