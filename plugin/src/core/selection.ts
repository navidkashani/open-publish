/**
 * Which files are candidates for publishing.
 *
 * Mirrors the resolution order Obsidian Publish itself uses (frontmatter beats
 * folder rules), with one addition: an `explicit` map recording per-file
 * decisions the user made in the publish modal. Nothing here ever writes to a
 * note: selection state lives entirely in plugin settings.
 */

/** `true` = publish, `false` = never publish, `null` = offered but unchecked by default. */
export type PublishFlag = boolean | null

export interface SelectionRules {
  includes: string[]
  excludes: string[]
  explicit: Record<string, boolean>
}

export const MARKDOWN_EXTENSIONS = ['md'] as const
export const IMAGE_EXTENSIONS = ['bmp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'] as const
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus'] as const
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'ogv', 'h264', 'avi', 'mov'] as const
export const OTHER_EXTENSIONS = ['pdf', 'canvas'] as const

/** The same set Obsidian Publish accepts. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set<string>([
  ...MARKDOWN_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...OTHER_EXTENSIONS,
])

export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash && dot !== -1 ? path.slice(dot + 1).toLowerCase() : ''
}

export function isSupportedFile(path: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extensionOf(path))
}

/**
 * Dot-folders are excluded unconditionally and are not user-configurable:
 * `.obsidian` holds credentials, `.trash` holds deleted notes, and neither
 * belongs on a public website.
 */
export function isAlwaysExcluded(path: string): boolean {
  return path.split('/').some((segment) => segment.startsWith('.'))
}

/**
 * Interpret a frontmatter `publish:` value.
 *
 * Accepts real booleans, the strings true/yes/false/no in any case, and 1/0,
 * matching Obsidian Publish, whose resolver is:
 *
 *   if (isString(n)) { if (n=="false"||n=="no") return false
 *                      if (n=="true" ||n=="yes") return true }
 *   return !!n
 *
 * One deliberate divergence: that final `!!n` makes *any* other non-empty
 * string publish the note, so `publish: draft` and `publish: maybe` both mean
 * "yes" in Obsidian Publish. We return null for those instead, so an
 * unrecognised value falls through to the folder rules rather than publishing
 * something the user did not mean to publish. Erring towards not-published is
 * the only safe direction for a typo.
 */
export function parsePublishFrontmatter(value: unknown): PublishFlag {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === 'yes') return true
    if (normalized === 'false' || normalized === 'no') return false
  }
  return null
}

/**
 * Strip the decoration people type around a folder name.
 *
 * Lives here rather than in the dialog that reads typed input, because
 * `matchesFolderRule` below is the function it has to agree with, and because
 * `core/publishconfig.ts` needs it while reading a foreign file. Deliberately
 * *not* `normalizePath`: this module stays free of the Obsidian import so it
 * can run under `node --test`. Callers that take typed input run
 * `normalizePath` over the result first. See `PathSuggest`'s consumers.
 */
export function normalizeFolderRule(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '')
}

/** True when `path` is inside (or equal to) the folder rule `prefix`. */
export function matchesFolderRule(path: string, prefix: string): boolean {
  const rule = prefix.replace(/^\/+|\/+$/g, '')
  if (rule === '') return true // an empty rule means "the whole vault"
  if (path === rule) return true
  return path.startsWith(rule + '/')
}

/**
 * Resolve the publish flag for one file.
 *
 * Order: frontmatter, then the user's explicit per-file choice, then excludes,
 * then includes. Frontmatter is first because it lives in the note itself and
 * is the only signal that travels with the content between vaults.
 */
export function getPublishFlag(
  path: string,
  frontmatterPublish: unknown,
  rules: SelectionRules,
): PublishFlag {
  if (isAlwaysExcluded(path) || !isSupportedFile(path)) return false

  const fromFrontmatter = parsePublishFrontmatter(frontmatterPublish)
  if (fromFrontmatter !== null) return fromFrontmatter

  const explicit = rules.explicit[path]
  if (typeof explicit === 'boolean') return explicit

  for (const rule of rules.excludes) {
    if (matchesFolderRule(path, rule)) return false
  }
  for (const rule of rules.includes) {
    if (matchesFolderRule(path, rule)) return true
  }
  return null
}
