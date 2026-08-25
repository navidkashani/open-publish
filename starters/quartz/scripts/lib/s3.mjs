/**
 * Read-only S3 client for the build environment.
 *
 * Dependency-free on purpose: this runs before `npm install` has any say in
 * what the build can reach, and a signing library that drifts out of step with
 * the plugin's signer is a failure mode nobody would enjoy debugging. Node's
 * built-in crypto and fetch are enough for GET.
 */

import { createHash, createHmac } from 'node:crypto'

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/

export function uriEncode(input, encodeSlash = true) {
  let out = ''
  for (const byte of Buffer.from(input, 'utf8')) {
    const char = String.fromCharCode(byte)
    if (byte < 0x80 && UNRESERVED.test(char)) out += char
    else if (char === '/' && !encodeSlash) out += '/'
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

export const EMPTY_PAYLOAD_SHA256 = sha256('')

export class S3Reader {
  constructor(config) {
    this.config = config
  }

  static fromEnv(env = process.env) {
    const required = ['OP_ENDPOINT', 'OP_BUCKET', 'OP_ACCESS_KEY_ID', 'OP_SECRET_ACCESS_KEY']
    const missing = required.filter((name) => !env[name])
    if (missing.length > 0) {
      throw new Error(
        `Missing environment variable(s): ${missing.join(', ')}.\n` +
          "Set these in your host's build settings (for Cloudflare Pages: Settings -> Environment variables), " +
          'using the read-only storage token.',
      )
    }
    return new S3Reader({
      endpoint: env.OP_ENDPOINT.replace(/\/+$/, ''),
      bucket: env.OP_BUCKET,
      region: env.OP_REGION || 'auto',
      accessKeyId: env.OP_ACCESS_KEY_ID,
      secretAccessKey: env.OP_SECRET_ACCESS_KEY,
      prefix: (env.OP_PREFIX || '').replace(/^\/+|\/+$/g, ''),
      forcePathStyle: env.OP_FORCE_PATH_STYLE !== 'false',
    })
  }

  url(key) {
    const fullKey = this.config.prefix ? `${this.config.prefix}/${key}` : key
    const endpoint = new URL(this.config.endpoint)
    const encoded = uriEncode(fullKey, false)
    if (!this.config.forcePathStyle) {
      return `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}/${encoded}`
    }
    return `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, '')}/${this.config.bucket}/${encoded}`
  }

  sign(method, urlString, now = new Date()) {
    const url = new URL(urlString)
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
    const stamp = amzDate.slice(0, 8)

    const headers = {
      host: url.host,
      'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
      'x-amz-date': amzDate,
    }
    const names = Object.keys(headers).sort()
    const canonicalRequest = [
      method,
      uriEncode(decodeURIComponent(url.pathname), false),
      '',
      names.map((n) => `${n}:${headers[n]}\n`).join(''),
      names.join(';'),
      EMPTY_PAYLOAD_SHA256,
    ].join('\n')

    const scope = `${stamp}/${this.config.region}/s3/aws4_request`
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')

    let key = Buffer.from(`AWS4${this.config.secretAccessKey}`, 'utf8')
    for (const part of [stamp, this.config.region, 's3', 'aws4_request']) key = hmac(key, part)

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${names.join(';')}, Signature=${hmac(key, stringToSign).toString('hex')}`
    return headers
  }

  /** Returns a Buffer, or null when the key does not exist. */
  async get(key, { retries = 3, fetchImpl = fetch } = {}) {
    const url = this.url(key)
    let lastError

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetchImpl(url, { headers: this.sign('GET', url) })
        if (response.status === 404) return null
        if (response.status === 403) {
          throw new Error(
            'Storage rejected the build credentials (403). Check OP_ACCESS_KEY_ID and OP_SECRET_ACCESS_KEY, ' +
              'and that the token is scoped to this bucket.',
          )
        }
        if (!response.ok) throw new Error(`Storage returned HTTP ${response.status} for ${key}`)
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        lastError = error
        // Credential problems will not fix themselves; fail immediately.
        if (String(error.message).includes('403')) throw error
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
      }
    }
    throw lastError
  }

  async getJson(key, options) {
    const body = await this.get(key, options)
    return body ? JSON.parse(body.toString('utf8')) : null
  }
}

export { sha256 }
