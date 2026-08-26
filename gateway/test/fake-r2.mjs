/**
 * A fake R2 binding, and the Workers-only crypto primitive Node lacks.
 *
 * Shared because two suites drive this Worker: its own tests, and the contract
 * test that runs the plugin's real `GatewayDestination` against it. A second
 * copy of the conditional-write semantics is a second chance to get RFC 7232
 * subtly wrong in one place and not the other, which would make the two suites
 * agree with each other and disagree with R2.
 */

export const comparisons = []

/**
 * `crypto.subtle.timingSafeEqual` is a Workers extension. Install before
 * importing the Worker. The real one throws on a length mismatch rather than
 * returning false, which is exactly why the Worker must not hand it two
 * different lengths, so this one throws too.
 */
export function installTimingSafeEqual() {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value(a, b) {
      comparisons.push([a.byteLength, b.byteLength])
      if (a.byteLength !== b.byteLength) throw new TypeError('lengths must match')
      return Buffer.from(a).equals(Buffer.from(b))
    },
  })
}

/** An R2 bucket with etags, conditional writes and paging. */
export function fakeBucket(seed = {}) {
  const objects = new Map()
  let counter = 0
  for (const [key, text] of Object.entries(seed)) {
    objects.set(key, { key, bytes: Buffer.from(text), etag: `etag-${++counter}`, uploaded: new Date(1000) })
  }

  const entry = (record) => ({
    key: record.key,
    etag: record.etag,
    size: record.bytes.byteLength,
    uploaded: record.uploaded,
    httpMetadata: record.contentType ? { contentType: record.contentType } : undefined,
  })

  /**
   * RFC 7232 semantics over a `Headers` object, because that is what the
   * Worker hands the binding: `*` matches any existing representation, and a
   * condition on a key that is not there is judged against "no etag at all".
   */
  const passes = (onlyIf, existing) => {
    if (!onlyIf) return true
    const ifMatch = onlyIf.get('If-Match')
    const ifNoneMatch = onlyIf.get('If-None-Match')
    if (ifMatch) {
      if (!existing) return false
      if (ifMatch !== '*' && ifMatch.replace(/"/g, '') !== existing.etag) return false
    }
    if (ifNoneMatch) {
      if (ifNoneMatch === '*') return !existing
      if (existing && ifNoneMatch.replace(/"/g, '') === existing.etag) return false
    }
    return true
  }

  return {
    objects,
    async put(key, value, options = {}) {
      const existing = objects.get(key)
      if (!passes(options.onlyIf, existing)) return null
      const record = {
        key,
        bytes: Buffer.from(new Uint8Array(value)),
        etag: `etag-${++counter}`,
        uploaded: new Date(2000),
        contentType: options.httpMetadata?.contentType,
      }
      objects.set(key, record)
      return entry(record)
    },
    async get(key) {
      const record = objects.get(key)
      if (!record) return null
      return { ...entry(record), body: new Response(record.bytes).body }
    },
    async head(key) {
      const record = objects.get(key)
      return record ? entry(record) : null
    },
    async delete(key) {
      objects.delete(key)
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const all = [...objects.values()].filter((record) => record.key.startsWith(prefix)).sort((a, b) => (a.key < b.key ? -1 : 1))
      const start = cursor ? Number(cursor) : 0
      const page = all.slice(start, start + limit)
      const end = start + page.length
      return { objects: page.map(entry), truncated: end < all.length, cursor: end < all.length ? String(end) : undefined }
    },
  }
}

