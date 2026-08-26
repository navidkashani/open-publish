/**
 * The storage contract.
 *
 * Deliberately four verbs plus two GC-only ones. `list()` and `delete()` are
 * *not* on the publish path, so a future Git-backed destination (design note
 * 2.11) that cannot list efficiently can still implement this interface.
 */

export interface PutOptions {
  contentType?: string
  /**
   * Conditional write. `ifMatch` is the compare-and-swap that makes committing
   * `current.json` safe when two devices publish at once; `ifNoneMatch: '*'`
   * creates a key only if it does not already exist.
   */
  ifMatch?: string
  ifNoneMatch?: string
}

export interface PutResult {
  etag?: string
}

/**
 * Reads go through Obsidian's `requestUrl`, which uses Electron's HTTP cache.
 * A GET of a key whose whole point is to change is exactly the wrong thing to
 * serve from a cache, so every read says so, and the mutable pointer, where a
 * stale answer means publishing against a site state that no longer exists,
 * also gets a URL nothing can have cached.
 */
export interface ReadOptions {
  /** Guarantee a round trip, not merely a revalidation. */
  fresh?: boolean
}

export interface HeadResult {
  size: number
  etag?: string
}

export interface ListEntry {
  key: string
  size: number
  lastModified?: number
}

/**
 * What a live check found out about conditional writes, as opposed to what the
 * catalogue expected. `ignored` is the dangerous one: the provider accepted a
 * write it should have refused, so two devices can silently overwrite each
 * other. `unsupported` is merely weaker, and the publisher degrades to
 * read-then-warn for it.
 */
export type ConcurrencySupport = 'enforced' | 'ignored' | 'unsupported'

export type TestResult =
  | { ok: true; conditionalWrites?: ConcurrencySupport }
  | { ok: false; reason: string; hint?: string }

export interface Destination {
  readonly id: string
  /** Human-readable target, for the UI. */
  describe(): string
  test(): Promise<TestResult>
  put(key: string, body: ArrayBuffer, options?: PutOptions): Promise<PutResult>
  get(key: string, options?: ReadOptions): Promise<ArrayBuffer | null>
  /** The dedupe and resume fast path: skip a blob that is already in the bucket. */
  head(key: string, options?: ReadOptions): Promise<HeadResult | null>
  /**
   * Read a key together with its ETag, so a later write can use If-Match.
   * Optional: a destination without conditional writes can omit it and the
   * publisher degrades to a read-then-warn check.
   */
  getWithEtag?(key: string, options?: ReadOptions): Promise<{ body: ArrayBuffer; etag?: string } | null>
  /** GC only. */
  list(prefix: string): Promise<ListEntry[]>
  /** GC only. */
  delete(key: string): Promise<void>
  /** False when the provider rejected conditional writes and we degraded to read-then-warn. */
  supportsConditionalWrites(): boolean
}
