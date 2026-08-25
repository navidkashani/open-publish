/**
 * Minimal AWS Signature V4 signer built on Web Crypto.
 *
 * Deliberately not the AWS SDK (see architecture note 2.6): "S3-compatible" is
 * not uniform across R2/B2/MinIO/S3, and recent SDK v3 releases send CRC32
 * checksum headers that several of those providers reject. Four verbs is all
 * this project needs, so we sign them ourselves.
 *
 * This module is intentionally free of any Obsidian import so it can be unit
 * tested under plain Node.
 */

const encoder = new TextEncoder()

/** RFC 3986 unreserved characters. Everything else is percent-encoded. */
const UNRESERVED = /^[A-Za-z0-9\-_.~]$/

/**
 * AWS-flavoured URI encoding. S3 object keys are encoded with `encodeSlash`
 * false (path separators survive); query string names and values are encoded
 * with it true.
 */
export function uriEncode(input: string, encodeSlash = true): string {
  let out = ''
  for (const byte of encoder.encode(input)) {
    const char = String.fromCharCode(byte)
    if (byte < 0x80 && UNRESERVED.test(char)) out += char
    else if (char === '/' && !encodeSlash) out += '/'
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return toHex(digest)
}

export function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function hmac(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

/** The empty-body payload hash, used for GET/HEAD/DELETE and empty PUTs. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export interface SignOptions {
  method: string
  /** Absolute URL, query string included. */
  url: string
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Hex SHA-256 of the request body. */
  payloadHashHex: string
  /**
   * Headers to include in the signature beyond host/x-amz-date/x-amz-content-sha256.
   *
   * Keep this set small and deterministic. Headers the HTTP transport may add or
   * rewrite on its own (Content-Type, Content-Length, User-Agent) must NOT be
   * signed: S3 only requires `host` and the `x-amz-*` headers to be covered, and
   * signing anything the transport can touch turns into a signature mismatch that
   * is very hard to diagnose from the client side.
   */
  extraSignedHeaders?: Record<string, string>
  /** Injectable for tests. */
  now?: Date
}

export interface SignedRequest {
  url: string
  /**
   * Headers to actually send.
   *
   * `host` is signed but deliberately NOT included here. It is a forbidden
   * header: browsers reject it outright and Electron's net — which backs
   * Obsidian's requestUrl — fails the request rather than ignoring it, which
   * surfaces as "couldn't reach the endpoint" and looks exactly like a network
   * outage. The transport sets Host from the URL anyway, and that is the value
   * S3 verifies the signature against, so omitting it changes nothing on the
   * wire except that the request now succeeds.
   */
  headers: Record<string, string>
  /** Exposed for debugging and for the signing unit tests. */
  canonicalRequest: string
  stringToSign: string
}

function amzDate(date: Date): { amz: string; stamp: string } {
  const amz = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amz, stamp: amz.slice(0, 8) }
}

/**
 * S3 signs the *decoded* path re-encoded with AWS's rules. We build our URLs
 * with `uriEncode` already, so this is normally an identity round-trip; the
 * try/catch covers a caller handing us a URL with a malformed escape sequence.
 */
function canonicalPath(url: URL): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return url.pathname
  }
  return uriEncode(decoded, false)
}

function canonicalQueryString(url: URL): string {
  const pairs: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => pairs.push([key, value]))
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&')
}

export async function signRequest(options: SignOptions): Promise<SignedRequest> {
  const url = new URL(options.url)
  const date = options.now ?? new Date()
  const { amz, stamp } = amzDate(date)

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': options.payloadHashHex,
    'x-amz-date': amz,
  }
  if (options.sessionToken) headers['x-amz-security-token'] = options.sessionToken
  for (const [name, value] of Object.entries(options.extraSignedHeaders ?? {})) {
    headers[name.toLowerCase()] = value
  }

  const sortedNames = Object.keys(headers).sort()
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = sortedNames.join(';')

  const canonicalRequest = [
    options.method.toUpperCase(),
    canonicalPath(url),
    canonicalQueryString(url),
    canonicalHeaders,
    signedHeaders,
    options.payloadHashHex,
  ].join('\n')

  const scope = `${stamp}/${options.region}/${options.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, await sha256Hex(canonicalRequest)].join('\n')

  let key: BufferSource = encoder.encode(`AWS4${options.secretAccessKey}`)
  for (const part of [stamp, options.region, options.service, 'aws4_request']) {
    key = new Uint8Array(await hmac(key, part))
  }
  const signature = toHex(await hmac(key, stringToSign))

  const { host: _host, ...sendable } = headers
  sendable['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { url: url.toString(), headers: sendable, canonicalRequest, stringToSign }
}
