/**
 * Carry the snapshot's resolved title, aliases and old URLs into each note's
 * frontmatter.
 *
 * The plugin already works out a note's real title (frontmatter `title`, else
 * the first H1, else the filename) and ships it in the snapshot. Without this
 * the generator falls back to the *file* name, which for us is the slug, so
 * every page ends up titled "cafe-resume" and the homepage titled "index".
 *
 * This is not a violation of "notes stay byte-identical": what is stored in the
 * bucket is the untouched file. This applies only to the working copy handed to
 * the generator, which already has its links rewritten.
 *
 * Anything the author wrote wins. A note with its own `title:` is left alone.
 *
 * Old URLs travel as `permalink`, not as one more alias, and that is the whole
 * of why this works. Quartz runs every `aliases` entry through
 * `slugifyFilePath`, which maps `&` to `-and-`, `%` to `-percent` and any space
 * to `-`, so the old URL of a note called "Wisdom & Approaches" would come out
 * at `/Wisdom+-and-+Approaches/…` and the real old link would 404 exactly as
 * before. `permalink` is the one frontmatter key Quartz turns into a redirect
 * page at the path it was given, character for character, capitals and `&` and
 * non-ASCII included. Checked against a real Quartz 4.5.1 build; `npm run
 * verify` is what keeps it checked.
 *
 * One old URL per note, because one is all `permalink` holds. Nothing publishes
 * more than one today; if that ever changes, the rest need `_redirects`.
 */

/** YAML double-quoted scalars accept JSON escaping. */
const quote = (value) => JSON.stringify(String(value))

export function applyNoteMetadata(text, meta = {}) {
  const additions = []
  const hasKey = (block, key) => block.some((line) => new RegExp(`^${key}\\s*:`).test(line))
  const legacyUrl = meta.legacyUrls?.[0]

  const lines = text.split('\n')
  const opensWithFrontmatter = lines[0]?.trim() === '---'

  if (!opensWithFrontmatter) {
    if (meta.title) additions.push(`title: ${quote(meta.title)}`)
    if (meta.aliases?.length) additions.push(`aliases: [${meta.aliases.map(quote).join(', ')}]`)
    if (legacyUrl) additions.push(`permalink: ${quote(legacyUrl)}`)
    if (additions.length === 0) return text
    return ['---', ...additions, '---', '', text].join('\n')
  }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i
      break
    }
  }
  // Unterminated frontmatter is the author's problem, not ours to rewrite.
  if (close === -1) return text

  const block = lines.slice(1, close)
  if (meta.title && !hasKey(block, 'title')) additions.push(`title: ${quote(meta.title)}`)
  if (meta.aliases?.length && !hasKey(block, 'aliases') && !hasKey(block, 'alias')) {
    additions.push(`aliases: [${meta.aliases.map(quote).join(', ')}]`)
  }
  // An author who set their own permalink already chose where this note lives,
  // and Obsidian Publish honoured that choice too, so their address is the one
  // worth keeping. A second would be a page fighting itself.
  if (legacyUrl && !hasKey(block, 'permalink')) additions.push(`permalink: ${quote(legacyUrl)}`)
  if (additions.length === 0) return text

  return [...lines.slice(0, close), ...additions, ...lines.slice(close)].join('\n')
}
