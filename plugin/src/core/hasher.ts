/**
 * SHA-256 per file, as cheaply as possible.
 *
 * Obsidian already maintains a content hash for every file and exposes it via
 * the undocumented `metadataCache.getFileInfo(path)` -> `{ mtime, size, hash }`.
 * When mtime and size still match the file's stat, that hash is reused and
 * hashing a whole vault costs nothing.
 *
 * Verified against Obsidian 1.13.7. It is undocumented, so every use is guarded
 * and the fallback (readBinary + crypto.subtle) is a fully supported path: if
 * the API disappears the plugin gets slower, not broken.
 */

import type { App, TFile } from 'obsidian'
import { toHex } from '../destinations/sigv4.ts'

export interface HashCacheEntry {
  hash: string
  mtime: number
  size: number
}

export type HashCache = Record<string, HashCacheEntry>

interface FileInfo {
  mtime: number
  size: number
  hash: string
}

const SHA256_HEX = /^[0-9a-f]{64}$/i

/** Narrow the undocumented API without asserting it exists. */
function readFileInfo(app: App, path: string): FileInfo | null {
  const cache = app.metadataCache as unknown as { getFileInfo?: (path: string) => unknown }
  if (typeof cache.getFileInfo !== 'function') return null
  try {
    const info = cache.getFileInfo(path) as Partial<FileInfo> | null | undefined
    if (!info || typeof info.hash !== 'string' || !SHA256_HEX.test(info.hash)) return null
    if (typeof info.mtime !== 'number' || typeof info.size !== 'number') return null
    return { mtime: info.mtime, size: info.size, hash: info.hash.toLowerCase() }
  } catch {
    return null
  }
}

export class Hasher {
  /** Set once per session, for the diagnostics line in settings. */
  private fastPathAvailable: boolean | null = null

  private readonly app: App
  private readonly cache: HashCache

  constructor(app: App, cache: HashCache) {
    this.app = app
    this.cache = cache
  }

  isFastPathAvailable(): boolean | null {
    return this.fastPathAvailable
  }

  /**
   * Hash order of preference:
   *   1. our own cache, when mtime and size are unchanged
   *   2. Obsidian's metadata cache, likewise validated against stat
   *   3. read the bytes and hash them
   */
  async hash(file: TFile): Promise<string> {
    const { mtime, size } = file.stat

    const cached = this.cache[file.path]
    if (cached && cached.mtime === mtime && cached.size === size) return cached.hash

    const info = readFileInfo(this.app, file.path)
    if (this.fastPathAvailable === null) this.fastPathAvailable = info !== null
    if (info && info.mtime === mtime && info.size === size) {
      this.cache[file.path] = { hash: info.hash, mtime, size }
      return info.hash
    }

    const bytes = await this.app.vault.readBinary(file)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = toHex(digest)
    this.cache[file.path] = { hash, mtime, size }
    return hash
  }

  /**
   * Drop entries for files that no longer exist, so the cache cannot grow
   * without bound across renames. Entries are keyed by path + mtime + size, so
   * a stale entry is harmless anyway: this is housekeeping, not correctness.
   */
  prune(livePaths: Set<string>): void {
    for (const path of Object.keys(this.cache)) {
      if (!livePaths.has(path)) delete this.cache[path]
    }
  }
}
