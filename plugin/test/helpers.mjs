/** An in-memory Destination with ETags and real conditional-write semantics. */
export class FakeDestination {
  constructor({ conditionalWrites = true } = {}) {
    this.id = 'fake'
    this.objects = new Map() // key -> { body, etag, lastModified }
    this.log = []
    this.conditionalWrites = conditionalWrites
    this.failOn = null // (key, method) => Error | null
    this.etagCounter = 0
  }

  describe() { return 'fake' }
  supportsConditionalWrites() { return this.conditionalWrites }

  #maybeFail(key, method) {
    const error = this.failOn?.(key, method)
    if (error) throw error
  }

  async put(key, body, options = {}) {
    this.log.push({ method: 'PUT', key })
    this.#maybeFail(key, 'PUT')

    if (this.conditionalWrites) {
      const existing = this.objects.get(key)
      if (options.ifNoneMatch === '*' && existing) {
        const { PublishError } = await import('../src/core/errors.ts')
        throw new PublishError('storage-conflict', 'Object already exists.')
      }
      if (options.ifMatch && existing?.etag !== options.ifMatch) {
        const { PublishError } = await import('../src/core/errors.ts')
        throw new PublishError('storage-conflict', 'ETag mismatch.')
      }
    }

    const etag = `etag-${++this.etagCounter}`
    this.objects.set(key, { body, etag, lastModified: Date.now() })
    return { etag }
  }

  async get(key) {
    this.log.push({ method: 'GET', key })
    this.#maybeFail(key, 'GET')
    return this.objects.get(key)?.body ?? null
  }

  async getWithEtag(key) {
    this.log.push({ method: 'GET', key })
    this.#maybeFail(key, 'GET')
    const entry = this.objects.get(key)
    return entry ? { body: entry.body, etag: entry.etag } : null
  }

  async head(key) {
    this.log.push({ method: 'HEAD', key })
    this.#maybeFail(key, 'HEAD')
    const entry = this.objects.get(key)
    return entry ? { size: entry.body.byteLength, etag: entry.etag } : null
  }

  async list(prefix) {
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, size: entry.body.byteLength, lastModified: entry.lastModified }))
  }

  async delete(key) {
    this.log.push({ method: 'DELETE', key })
    this.objects.delete(key)
  }

  // --- assertions used by the tests ---
  text(key) {
    const entry = this.objects.get(key)
    return entry ? new TextDecoder().decode(entry.body) : null
  }

  writeOrder() {
    return this.log.filter((entry) => entry.method === 'PUT').map((entry) => entry.key)
  }
}

export const bytes = (text) => new TextEncoder().encode(text).buffer

export const site = {
  title: 'Notes',
  homepage: '',
  locale: 'en-US',
  dir: 'ltr',
  noIndex: false,
  showThemeToggle: true,
  strictLineBreaks: false,
  showNavigation: true,
  showSearch: true,
  showGraph: true,
  showOutline: true,
  showBacklinks: true,
  showTags: true,
  analytics: { provider: 'none', id: '' },
}

export function makeScan({ files, previous = null, currentEtag, isFirstPublish = true, blockers = [] }) {
  return {
    snapshot: {
      version: 1,
      id: 'placeholder',
      parent: previous?.id ?? null,
      createdAt: 1_700_000_000_000,
      generator: { plugin: 'open-publish', version: '0.1.0' },
      site,
      files,
      links: {},
      redirects: [],
    },
    previous,
    currentEtag,
    isFirstPublish,
    added: Object.keys(files),
    changed: [],
    unchanged: [],
    removed: [],
    renames: [],
    autoIncluded: new Set(),
    linkedButUnpublished: [],
    blockers,
    warnings: [],
    totalBytes: 0,
  }
}
