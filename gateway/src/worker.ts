/**
 * The Open Publish gateway.
 *
 * A Worker *you* own, bound by Cloudflare to *your* R2 bucket, so that no
 * storage credential exists on your device at all. The plugin holds one bearer
 * token, and that token can reach this Worker and nothing else.
 *
 * Be precise about what this buys, because the honest claim is narrower than
 * the obvious one. The token lives in Obsidian's keychain rather than in
 * `data.json`, so it is out of the vault and does not sync, and on most
 * machines the operating system encrypts it at rest. It is still readable by
 * every other Obsidian plugin, because that keychain is one shared store and
 * reading it is public API. **That is not this Worker's doing and it is not
 * encryption you hold the key to.** What this Worker changes is blast radius,
 * which is a different axis entirely: where the credential lives is one
 * question, and what it can reach is the other. A leaked S3 key reaches a bucket
 * directly, with whatever permissions it was cut with. A leaked gateway token
 * reaches one Worker, which reaches one bucket, or one prefix of it if PREFIX
 * is set, and rotating it is one `wrangler secret put` in one place. Note which
 * half of that is the default: PREFIX ships empty, so out of the box the bound
 * bucket *is* the boundary.
 *
 * The API is deliberately small and deliberately not S3. A Worker speaking S3
 * would need no plugin changes at all, but it would have to verify SigV4
 * signatures, and a subtle mistake in signature verification is an
 * authentication bypass. A token comparison is a handful of lines and
 * obviously correct.
 *
 *   PUT    /o/<key>   body, optional If-Match / If-None-Match -> 200 {etag} | 412
 *   GET    /o/<key>                                           -> 200 body + ETag | 404
 *   HEAD   /o/<key>                                           -> 200 size + ETag | 404
 *   DELETE /o/<key>                                           -> 204
 *   GET    /l?prefix=&cursor=                                 -> 200 {entries, cursor?}
 *
 * Every request carries `Authorization: Bearer <token>`, or gets no answer.
 */

declare global {
  interface SubtleCrypto {
    /**
     * A Workers runtime extension, not part of Web Crypto, so it has to be
     * declared here for `tsc` to see it. It throws rather than returning false
     * when the two views differ in length, which is why the caller checks.
     */
    timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean
  }
}

// --- the binding ---------------------------------------------------------

/**
 * The slice of the R2 binding this Worker touches, declared here rather than
 * pulled from `@cloudflare/workers-types`.
 *
 * Five methods, so the dependency would buy very little, and the cost of not
 * having it is that this file type-checks and unit-tests under plain Node with
 * nothing installed. If this Worker grows, take the real types instead of
 * extending these.
 */
interface R2Object {
  key: string
  etag: string
  size: number
  uploaded: Date
  httpMetadata?: { contentType?: string }
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream
}

interface R2Objects {
  objects: R2Object[]
  truncated: boolean
  cursor?: string
}

interface R2Bucket {
  put(
    key: string,
    value: ArrayBuffer | null,
    options?: { onlyIf?: Headers; httpMetadata?: { contentType?: string } },
  ): Promise<R2Object | null>
  get(key: string): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>
}

export interface Env {
  BUCKET: R2Bucket
  /** The bearer token the plugin holds. Set with `wrangler secret put TOKEN`. */
  TOKEN: string
  /**
   * The prefix every key is forced under, enforced *here* rather than asked
   * for by the client. This is what stops a stolen token reaching the rest of
   * the bucket, so it is a Worker variable and not a request parameter.
   */
  PREFIX?: string
}

// --- the entry point -----------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // A Worker deployed without its secret would otherwise compare every
    // caller's token against the empty string, which is a bucket open to
    // anyone who finds the address.
    if (!env.TOKEN) return problem(500, 'This Worker has no TOKEN set. Run: wrangler secret put TOKEN')
    if (!isAuthorized(request, env.TOKEN)) return unauthorized()

    const url = new URL(request.url)
    if (url.pathname === '/l') return handleList(request, env, url)
    if (url.pathname.startsWith('/o/')) return handleObject(request, env, url)
    return problem(404, 'Not a gateway route. Objects live under /o/, listing under /l.')
  },
}

// --- authentication ------------------------------------------------------

/**
 * The one piece of security-critical code in this file, so it follows
 * Cloudflare's documented pattern exactly.
 *
 * The part that looks wrong and is not: there is **no early return when the
 * lengths differ**. Returning there would answer a short guess faster than a
 * long one, which leaks the secret's length through response timing. Their
 * idiom for keeping both branches equally expensive is to compare the input
 * against itself and negate the result.
 */
function isAuthorized(request: Request, secret: string): boolean {
  const match = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')
  if (!match) return false

  const encoder = new TextEncoder()
  const given = encoder.encode(match[1])
  const expected = encoder.encode(secret)

  return given.byteLength === expected.byteLength
    ? crypto.subtle.timingSafeEqual(given, expected)
    : !crypto.subtle.timingSafeEqual(given, given)
}

/**
 * No detail, on purpose. "Wrong token" and "no token" are the same answer, and
 * nothing here says whether the bucket, the key or the prefix exists.
 */
function unauthorized(): Response {
  return json({ error: 'Unauthorized.' }, 401, { 'WWW-Authenticate': 'Bearer' })
}

// --- objects -------------------------------------------------------------

async function handleObject(request: Request, env: Env, url: URL): Promise<Response> {
  const relative = decodeKey(url.pathname.slice('/o/'.length))
  if (relative === null) return problem(400, 'That key is not allowed.')
  const key = withPrefix(env, relative)

  switch (request.method) {
    case 'PUT':
      return putObject(request, env, key)
    case 'GET':
      return getObject(env, key)
    case 'HEAD':
      return headObject(env, key)
    case 'DELETE':
      await env.BUCKET.delete(key)
      // R2 does not distinguish "deleted" from "was never there", and neither
      // does S3. Both are the state the caller asked for.
      return new Response(null, { status: 204, headers: SIGNATURE })
    default:
      return problem(405, `${request.method} is not allowed on an object.`)
  }
}

/**
 * The compare-and-swap that makes two-device publishing safe.
 *
 * Conditions are passed through as a `Headers` object rather than as an
 * `R2Conditional`. That is the path Cloudflare fixed to parse strong, weak and
 * **wildcard** etags, and the wildcard is the whole of `If-None-Match: *`,
 * which is what guards a first publish. Handing R2 the client's own headers
 * also means the semantics are HTTP's, not a re-implementation of them.
 *
 * On a failed precondition `put()` returns `null` and stores nothing. That is
 * the only signal, and mistaking it for success is exactly the silent
 * overwrite this mechanism exists to prevent, so it is checked before anything
 * else is read off the result.
 */
async function putObject(request: Request, env: Env, key: string): Promise<Response> {
  const ifMatch = request.headers.get('If-Match')
  const ifNoneMatch = request.headers.get('If-None-Match')

  // A supplement to the conditional below, never a substitute for it. R2's
  // bindings shipped a period where a wildcard etag was parsed as a literal
  // one, and a "create only if absent" that silently overwrote is the worst
  // failure this project has. This catches the ordinary case (the other device
  // already landed) on a runtime with that bug; the conditional is still what
  // decides a genuine tie.
  if (ifNoneMatch === '*' && (await env.BUCKET.head(key))) {
    return problem(412, 'That key already exists.')
  }

  const onlyIf = new Headers()
  if (ifMatch) onlyIf.set('If-Match', ifMatch)
  if (ifNoneMatch) onlyIf.set('If-None-Match', ifNoneMatch)

  const body = await request.arrayBuffer()
  const contentType = request.headers.get('Content-Type') ?? undefined
  const written = await env.BUCKET.put(key, body, {
    ...(ifMatch || ifNoneMatch ? { onlyIf } : {}),
    ...(contentType ? { httpMetadata: { contentType } } : {}),
  })

  if (!written) return problem(412, 'The object changed while this write was in flight.')
  return json({ etag: written.etag }, 200, { ETag: quote(written.etag) })
}

async function getObject(env: Env, key: string): Promise<Response> {
  const object = await env.BUCKET.get(key)
  if (!object) return keyMiss()
  // No Content-Length: the body is a stream, and the runtime frames it. Stating
  // a length beside a stream is a way for the two to disagree, and nothing on
  // the other end reads it on a GET anyway.
  return new Response(object.body, { status: 200, headers: objectHeaders(object) })
}

/**
 * The dedupe fast path: the plugin asks whether a blob is already here before
 * uploading it. Content-Length is the answer to "how big", and belongs here,
 * where there is no body for it to contradict.
 */
async function headObject(env: Env, key: string): Promise<Response> {
  const object = await env.BUCKET.head(key)
  if (!object) return keyMiss()
  return new Response(null, {
    status: 200,
    headers: { ...objectHeaders(object), 'Content-Length': String(object.size) },
  })
}

function objectHeaders(object: R2Object): Record<string, string> {
  return {
    ...SIGNATURE,
    ETag: quote(object.etag),
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    // The plugin reads keys whose whole point is to change. Nothing between
    // here and Obsidian may answer one from a cache.
    'Cache-Control': 'no-store',
  }
}

// --- listing -------------------------------------------------------------

/**
 * JSON rather than S3's ListObjectsV2 XML, because nothing needs the XML.
 *
 * Paged with a cursor rather than flattened here: a vault is many small
 * objects, and a bucket with tens of thousands of them would otherwise be one
 * response the Worker has to hold whole. The plugin loops, exactly as it
 * already does for S3's continuation token.
 */
async function handleList(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return problem(405, `${request.method} is not allowed on /l.`)

  const asked = url.searchParams.get('prefix') ?? ''
  // '' is a legitimate prefix here (list everything) where it is not a
  // legitimate key, so only the dangerous shapes are refused.
  if (asked && !isSafeKey(asked)) return problem(400, 'That prefix is not allowed.')

  const enforced = normalizedPrefix(env)
  const cursor = url.searchParams.get('cursor')
  const listed = await env.BUCKET.list({
    prefix: withPrefix(env, asked),
    limit: 1000,
    ...(cursor ? { cursor } : {}),
  })

  return json({
    // Relative to the enforced prefix, so the plugin never has to know there
    // is one. It strips its own prefix on top of this, the same way it does
    // when it talks to S3 directly.
    entries: listed.objects.map((object) => ({
      key: enforced && object.key.startsWith(enforced + '/') ? object.key.slice(enforced.length + 1) : object.key,
      size: object.size,
      lastModified: object.uploaded.getTime(),
    })),
    ...(listed.truncated && listed.cursor ? { cursor: listed.cursor } : {}),
  })
}

// --- keys ----------------------------------------------------------------

function normalizedPrefix(env: Env): string {
  return (env.PREFIX ?? '').replace(/^\/+|\/+$/g, '')
}

function withPrefix(env: Env, key: string): string {
  const prefix = normalizedPrefix(env)
  return prefix ? `${prefix}/${key}` : key
}

function decodeKey(raw: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  return isSafeKey(decoded) ? decoded : null
}

/**
 * The prefix above is only a boundary if nothing can walk out of it, so this
 * runs before a key reaches R2.
 *
 * The `..` rule is the one that looks redundant and is not. On the object route
 * it never fires: `new URL(request.url)` removes dot segments, encoded ones
 * included, so `/o/../secrets.json` has already become `/secrets.json` and
 * missed the route altogether. On the *list* route it is the whole defence,
 * because a prefix rides in the query string and nothing normalises that.
 *
 * Refused as a substring rather than as a path segment. Nothing Open Publish
 * writes contains `..`, so the stricter rule costs nothing and leaves no
 * encoding trick to reason about.
 */
function isSafeKey(key: string): boolean {
  if (!key) return false
  if (key.length > 1024) return false
  if (key.startsWith('/')) return false
  if (key.includes('..')) return false
  if (key.includes('\\')) return false
  if (/[\u0000-\u001f\u007f]/.test(key)) return false
  return true
}

// --- answers -------------------------------------------------------------

/**
 * On every answer, including the failures.
 *
 * A 404 is the one status where "this is a gateway" and "this is not" mean
 * opposite things. Without this, a plugin pointed at the wrong address reads
 * the 404 for `current.json` as "nothing has been published yet" and shows the
 * whole vault as unpublished, which is alarming, wrong, and arrives nowhere
 * near the field that caused it.
 */
const SIGNATURE = { 'X-Open-Publish-Gateway': '1' }

/**
 * A 404 that means "this object is not here", as opposed to every other 404.
 *
 * The distinction has to be on the wire, because on the client side the two are
 * the same status from the same address. A missing object is an ordinary answer
 * on the publish path and the caller wants null for it. Anything else, most
 * plausibly a Worker reached at a path this route does not serve, must not be
 * read that way: the plugin turns a null pointer into "nothing has ever been
 * published" and shows somebody their entire vault as unpublished.
 *
 * The signature alone cannot carry this. It says the gateway answered, and the
 * gateway is exactly what answers 404 when the address carries a path prefix
 * its routes do not match.
 */
function keyMiss(): Response {
  return json({ error: 'No such key.' }, 404, { 'X-Open-Publish-Miss': 'key' })
}

function quote(etag: string): string {
  return etag.startsWith('"') ? etag : `"${etag}"`
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SIGNATURE, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })
}

/** One shape for every failure, so the plugin has one thing to read. */
function problem(status: number, error: string): Response {
  return json({ error }, status)
}
