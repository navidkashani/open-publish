/**
 * Platform limits that shape the design, verified against Cloudflare docs.
 *
 * These are not arbitrary safety margins: each one is a hard wall where the
 * failure, if we let the user hit it, is confusing rather than obvious.
 */

export const MiB = 1024 * 1024

/** Cloudflare Pages refuses to serve any asset larger than this. Blocking. */
export const MAX_ASSET_BYTES = 25 * MiB

/**
 * `requestUrl` has no streaming and no multipart, so the whole file sits in
 * memory. Above this we refuse outright rather than hang the app.
 */
export const MAX_UPLOAD_BYTES = 100 * MiB

/** Above this a single upload is slow enough to be worth warning about. */
export const WARN_FILE_BYTES = 25 * MiB

/** Pages allows 20,000 assets per deployment on the free plan; leave headroom for generated pages. */
export const WARN_FILE_COUNT = 15000
export const MAX_FILE_COUNT = 19000

/** Pages build timeout is 20 minutes and the build re-downloads the whole snapshot. */
export const WARN_SNAPSHOT_BYTES = 500 * MiB

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * MiB) return `${(bytes / MiB).toFixed(1)} MB`
  return `${(bytes / (1024 * MiB)).toFixed(2)} GB`
}
