/**
 * Turn Obsidian link syntax into site links, using the resolved index the
 * plugin shipped inside the snapshot.
 *
 * This is the payoff of resolving links in the plugin rather than here. Obsidian
 * resolves `[[Note]]` against the whole vault — shortest-path matching, aliases,
 * attachment folders. A generator seeing only the published subset cannot
 * reproduce that. So the plugin does the resolving, and this file only applies
 * the answer.
 *
 * Three outcomes per link:
 *   published    -> a real site link
 *   unpublished  -> plain text (the note exists, but was not published)
 *   unresolved   -> plain text (nothing matched, even in the full vault)
 *
 * Rendering a dead-end link is worse than rendering an un-linked phrase, which
 * is why neither of the last two becomes an <a>.
 */

const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"[^"]*")?\)/g

/**
 * Byte ranges the rewriter must not touch: frontmatter, fenced code blocks and
 * inline code spans. A `[[link]]` inside a code fence is documentation *about*
 * links and must survive verbatim.
 */
export function protectedRanges(text) {
  const ranges = []
  const lines = text.split('\n')
  let offset = 0
  let fence = null

  // YAML frontmatter, when the file opens with it.
  if (lines[0]?.trim() === '---') {
    let cursor = lines[0].length + 1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        ranges.push([0, cursor + lines[i].length])
        break
      }
      cursor += lines[i].length + 1
    }
  }

  for (const line of lines) {
    const trimmed = line.trimStart()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)

    if (fence) {
      ranges.push([offset, offset + line.length])
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
    } else if (fenceMatch) {
      fence = fenceMatch[1]
      ranges.push([offset, offset + line.length])
    } else {
      // Inline code spans, matching the longest run of backticks first.
      const spans = /(`+)(?:(?!\1)[\s\S])*\1/g
      let match
      while ((match = spans.exec(line)) !== null) {
        ranges.push([offset + match.index, offset + match.index + match[0].length])
      }
    }
    offset += line.length + 1
  }

  return ranges
}

const isProtected = (ranges, index) => ranges.some(([start, end]) => index >= start && index < end)

/** Heading anchors, matching how most static generators slugify them. */
export function anchorFor(subpath) {
  if (!subpath || subpath.startsWith('#^')) return '' // block refs have no stable URL anchor
  return (
    '#' +
    subpath
      .slice(1)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
  )
}

const isMarkdownTarget = (path) => /\.md$/i.test(path ?? '')

function displayFor(entry, explicitDisplay, rawTarget) {
  if (explicitDisplay) return explicitDisplay
  if (entry?.display) return entry.display

  // Match how Obsidian renders an un-aliased link: the last path segment
  // without its extension, and `Note > Heading` when it points at a heading.
  const [pathPart, ...rest] = (rawTarget ?? '').split('#')
  const base = (pathPart.split('/').pop() ?? pathPart).replace(/\.md$/i, '')
  const heading = rest.join('#')
  if (heading && !heading.startsWith('^')) return `${base} > ${heading}`
  return base || rawTarget || ''
}

/**
 * @param text     the note's markdown, byte-identical to the vault copy
 * @param links    the snapshot's link entries for this note
 * @param options.siteRoot prefix for generated URLs, '' for a site at the domain root
 */
export function rewriteLinks(text, links = [], options = {}) {
  const siteRoot = (options.siteRoot ?? '').replace(/\/+$/, '')
  const byRaw = new Map(links.map((entry) => [entry.raw, entry]))
  const wikilinkRanges = protectedRanges(text)

  const url = (slug, subpath) => `${siteRoot}/${slug}${anchorFor(subpath)}`

  let out = text.replace(WIKILINK, (match, bang, inner, index) => {
    if (isProtected(wikilinkRanges, index)) return match

    const pipe = inner.indexOf('|')
    const rawTarget = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    const alias = pipe === -1 ? undefined : inner.slice(pipe + 1).trim()

    // A bare `#heading` points inside this note; leave it for the generator.
    if (rawTarget.startsWith('#')) return match

    const entry = byRaw.get(rawTarget)
    const label = displayFor(entry, alias, rawTarget)

    if (!entry || entry.status !== 'published' || !entry.slug) return label

    if (bang === '!') {
      // Transclusion of a note stays a wikilink so the generator can inline it;
      // an embedded asset becomes a real image/media reference.
      return isMarkdownTarget(entry.target)
        ? `![[${entry.slug}${entry.subpath ?? ''}${alias ? '|' + alias : ''}]]`
        : `![${alias ?? ''}](${url(entry.slug)})`
    }
    return `[${label}](${url(entry.slug, entry.subpath)})`
  })

  // Measured again, against the text this pass actually walks. Rewriting a
  // wikilink changes its length, which moves everything after it — so ranges
  // taken from the original text would point at the wrong bytes here, and a
  // link inside a code fence would be rewritten as though it were prose.
  const markdownRanges = protectedRanges(out)

  out = out.replace(MARKDOWN_LINK, (match, bang, label, target, index) => {
    if (isProtected(markdownRanges, index)) return match
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(target)) return match // external, anchor, already absolute

    let decoded = target
    try {
      decoded = decodeURIComponent(target)
    } catch {
      // A malformed escape sequence is not ours to fix; compare the raw form.
    }

    const entry = byRaw.get(decoded) ?? byRaw.get(target)
    if (!entry) return match
    if (entry.status !== 'published' || !entry.slug) return label || displayFor(entry, undefined, decoded)

    const [, subpath] = decoded.split(/(?=#)/, 2)
    return bang === '!' && !isMarkdownTarget(entry.target)
      ? `![${label}](${url(entry.slug)})`
      : `[${label}](${url(entry.slug, subpath)})`
  })

  return out
}
