/**
 * Human-readable failures. The rule from the design review: never show a bare
 * HTTP status code. Every error the user can hit has a sentence that says what
 * broke and what to change.
 */

import { missingBucketHint } from '../destinations/providers.ts'

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

export function describeHookError(status: number): PublishError {
  if (status === 401 || status === 403 || status === 404) {
    return new PublishError('hook-rejected', 'The deploy hook was rejected. It may have been deleted.', {
      hint: 'Create a new deploy hook and paste the new URL into settings.',
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
