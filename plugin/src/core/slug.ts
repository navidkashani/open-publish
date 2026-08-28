/**
 * Vault path -> site slug.
 *
 * Object keys are content hashes, so storage is immune to filename weirdness
 * (design note 2.10). Slugs are the one place a real name still has to survive
 * a URL and a case-insensitive filesystem, so this is where normalisation and
 * collision detection live.
 */

/** Cyrillic is transliterated; scripts without an obvious ASCII mapping are kept as-is. */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

const LATIN_EXTRAS: Record<string, string> = {
  ß: 'ss', æ: 'ae', ø: 'o', å: 'a', œ: 'oe', đ: 'd', ł: 'l', þ: 'th', ð: 'd',
}

/**
 * Slugify one path segment.
 *
 * Latin diacritics are folded (é -> e) and Cyrillic transliterated, but letters
 * from scripts we cannot transliterate (CJK, Greek, Arabic…) are preserved:
 * a percent-encoded UTF-8 URL is far friendlier than a hash. Only characters
 * that have no business in a URL (emoji, punctuation, separators) are dropped.
 */
export function slugifySegment(segment: string): string {
  const folded = segment
    .normalize('NFC')
    .toLowerCase()
    .replace(/[Ѐ-ӿ]/g, (ch) => CYRILLIC[ch] ?? ch)
    .replace(/[ßæøåœđłþð]/g, (ch) => LATIN_EXTRAS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks left by NFD
    .normalize('NFC')

  const slug = folded
    .replace(/['’`]/g, '') // don't turn "don't" into "don-t"
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-.]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

  return slug
}

/** Deterministic stand-in for a segment that slugifies to nothing (e.g. "🎉.md"). */
function fallbackSegment(original: string, index: number): string {
  let hash = 2166136261
  for (let i = 0; i < original.length; i++) {
    hash ^= original.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `untitled-${index}-${(hash >>> 0).toString(36)}`
}

export interface SlugOptions {
  /** Value of the `permalink` frontmatter key, if the note sets one. It wins outright. */
  permalink?: string
}

/**
 * Compute the site-relative slug for a vault path.
 *
 * Markdown notes lose their extension (`Notes/My Note.md` -> `notes/my-note`);
 * every other file keeps it (`Attachments/Dia gram.PNG` -> `attachments/dia-gram.png`)
 * because the browser needs it to pick a content type.
 */
export function slugForPath(path: string, options: SlugOptions = {}): string {
  if (options.permalink) {
    const cleaned = options.permalink
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .map((s) => slugifySegment(s))
      .filter((s) => s.length > 0)
      .join('/')
    if (cleaned) return cleaned
  }

  const segments = path.split('/')
  const isMarkdown = /\.md$/i.test(path)
  const last = segments.pop() ?? ''
  const extension = isMarkdown ? '' : extensionOf(last)
  const baseName = extension ? last.slice(0, last.length - extension.length) : last.replace(/\.md$/i, '')

  const out = segments.map((segment, i) => slugifySegment(segment) || fallbackSegment(segment, i))
  out.push((slugifySegment(baseName) || fallbackSegment(baseName, segments.length)) + extension.toLowerCase())

  return out.join('/')
}

/**
 * How much of the old Obsidian Publish URL scheme a site keeps.
 *
 * `clean` is what this plugin has always done and what a new site wants:
 * lowercase, dash-separated, ASCII-safe. `clean-with-redirects` is the same
 * site plus a bouncing page at every URL Obsidian Publish used to serve, which
 * is only worth anything to somebody who kept the domain those URLs were on.
 */
export type UrlStyle = 'clean' | 'clean-with-redirects'

export function isUrlStyle(value: unknown): value is UrlStyle {
  return value === 'clean' || value === 'clean-with-redirects'
}

/**
 * Where Obsidian Publish served this file, as a path rather than as a URL.
 *
 * Obsidian form-urlencodes each path segment, so `Company/About us.md` was
 * served at `/Company/About+us`, and `Wisdom & Approaches/Critical Thinking.md`
 * at `/Wisdom+%26+Approaches/Critical+Thinking`. Both confirmed against live
 * sites.
 *
 * What comes back from here is that URL percent-*decoded*:
 * `Wisdom+&+Approaches/Critical+Thinking`. Decoded, because this is a path on
 * disk before it is anything else. A static host percent-decodes a request path
 * and then looks for a file at the result, so a file whose name really contains
 * `%26` answers `/…%2526…` and nothing else. The site already leans on that
 * decoding: `slugForPath` keeps CJK and Persian letters as they are, and those
 * pages are served today.
 *
 * Which leaves one substitution: a space becomes `+`. Everything else is the
 * vault path, character for character, with `.md` dropped exactly as
 * `slugForPath` drops it and an attachment keeping the extension a browser
 * needs to pick a content type.
 */
export function obsidianPublishUrl(path: string): string {
  return path
    .replace(/\.md$/i, '')
    .split('/')
    .map((segment) => segment.replace(/ /g, '+'))
    .join('/')
}

/**
 * The old URLs a file still has to answer at, or undefined when it has none.
 *
 * A file whose old URL is already its slug needs nothing: the page is at that
 * address anyway. Everything else does, including a difference of case alone,
 * because the build machine is Linux and `/Notes/Plain` is not `/notes/plain`
 * there. On a case-insensitive machine those two are one file and the real page
 * wins, which is the harmless direction.
 */
export function legacyUrlsFor(path: string, slug: string, style: UrlStyle): string[] | undefined {
  if (style !== 'clean-with-redirects') return undefined
  const url = obsidianPublishUrl(path)
  return url === slug ? undefined : [url]
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

export interface SlugCollision {
  slug: string
  paths: string[]
}

/**
 * Find slugs claimed by more than one file.
 *
 * This is what catches `Note.md` alongside `note.md`: fine on a case-insensitive
 * macOS or Windows vault, a silent overwrite on the Linux build box. Comparison
 * is case-insensitive even though slugs are already lower-cased, so the check
 * still holds if slug rules ever change.
 */
export function findSlugCollisions(slugsByPath: Map<string, string>): SlugCollision[] {
  const byKey = new Map<string, { slug: string; paths: string[] }>()
  for (const [path, slug] of slugsByPath) {
    const key = slug.toLowerCase()
    const entry = byKey.get(key)
    if (entry) entry.paths.push(path)
    else byKey.set(key, { slug, paths: [path] })
  }
  return [...byKey.values()]
    .filter((entry) => entry.paths.length > 1)
    .map((entry) => ({ slug: entry.slug, paths: entry.paths.sort() }))
}
