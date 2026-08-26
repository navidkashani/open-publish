/**
 * Platform limits that shape the design, and the sentences that explain them.
 *
 * These are not arbitrary safety margins: each one is a hard wall where the
 * failure, if we let the user hit it, is confusing rather than obvious.
 *
 * Every number below is the *tightest* limit among the hosts this works with,
 * which as it happens is Cloudflare Pages for all of them. That is why the
 * numbers are host-independent and the copy has to be too. It used to name
 * Cloudflare inside a blocking message, so a Netlify user was stopped from
 * publishing and told about a product they had never used. The numbers stay a
 * universal floor; only the wording changed.
 *
 * The copy lives here rather than in `scanner.ts` because it is copy *about*
 * these numbers, and because a pure module is the only part of the scanner a
 * test can reach without a vault.
 */

export const MiB = 1024 * 1024

/** No supported host will serve a single asset larger than this. Blocking. */
export const MAX_ASSET_BYTES = 25 * MiB

/**
 * `requestUrl` has no streaming and no multipart, so the whole file sits in
 * memory. Above this we refuse outright rather than hang the app.
 */
export const MAX_UPLOAD_BYTES = 100 * MiB

/** Above this a single upload is slow enough to be worth warning about. */
export const WARN_FILE_BYTES = 25 * MiB

/** 20,000 assets per deployment is the tightest cap; leave headroom for generated pages. */
export const WARN_FILE_COUNT = 15000
export const MAX_FILE_COUNT = 19000

/** Build timeouts start at 20 minutes, and the build re-downloads the whole snapshot. */
export const WARN_SNAPSHOT_BYTES = 500 * MiB

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < MiB) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * MiB) return `${(bytes / MiB).toFixed(1)} MB`
  return `${(bytes / (1024 * MiB)).toFixed(2)} GB`
}

/** Too big for us to hold in memory, whoever is hosting it. */
export function tooLargeToUploadMessage(path: string, size: number): string {
  return (
    `"${path}" is ${formatBytes(size)}. Open Publish uploads whole files in memory, ` +
    `so anything over ${formatBytes(MAX_UPLOAD_BYTES)} is refused.`
  )
}

/** Small enough to upload, too big for any host to serve back. */
export function tooLargeToServeMessage(path: string, size: number): string {
  return (
    `"${path}" is ${formatBytes(size)}. ${formatBytes(MAX_ASSET_BYTES)} is the most a single file can be, ` +
    'and above that it would not load on the live site at all. ' +
    'Link to it from your storage instead, or shrink it.'
  )
}

export function tooManyFilesMessage(count: number): string {
  return (
    `${count} files selected. One update can hold about 20,000 files, and the generated site adds ` +
    'more pages on top, so this build would fail. Narrow the include rules.'
  )
}

export function nearFileLimitWarning(count: number): string {
  return `${count} files selected, close to the 20,000 files one update can hold.`
}

export function largeSnapshotWarning(totalBytes: number): string {
  return (
    `This snapshot is ${formatBytes(totalBytes)}. The build downloads all of it, ` +
    'and builds are cut off after about 20 minutes.'
  )
}
