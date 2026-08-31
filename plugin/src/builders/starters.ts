/**
 * The starter catalogue: which generator builds the site, and what its build
 * needs the host told.
 *
 * The third table of this kind, after `destinations/providers.ts` and
 * `hosts.ts`, and it lives by the same rule: **none of it reaches the wire**. A
 * starter id never enters a snapshot and is never sent anywhere. The plugin
 * publishes byte-identical content whichever one is chosen, which is the whole
 * point of `architecture.md`'s rule that a site option is *intent* each starter
 * maps onto its own mechanisms. That is what lets a second starter exist
 * without the plugin knowing anything about it.
 *
 * So why keep the id at all, when the provider catalogue can get away with
 * calling itself pure presentation. Because one thing genuinely differs between
 * starters and it is not cosmetic: **where the build leaves the finished
 * site**. Quartz writes `public`, Astro writes `dist`, and a host told the
 * wrong one deploys an empty directory and reports success. That is the same
 * class of failure as `OP_FORCE_PATH_STYLE` disagreeing, found one step later
 * on a machine the user cannot see, so it is settled here rather than left to a
 * paragraph in somebody else's README.
 */

export type StarterId = 'quartz' | 'jotter'

/**
 * What the chosen starter's build needs the host told.
 *
 * Named here and taken structurally by `hosts.ts`, which composes it into its
 * own words: "Output directory" on Cloudflare, "Publish directory" on Netlify.
 */
export interface StarterBuild {
  /** The command the host runs. The same on both today, and still per-starter. */
  command: string
  /** Where the finished site lands. The one difference that silently breaks a deploy. */
  outputDir: string
  /**
   * Whether the repository ships a `wrangler.jsonc`, which is what makes
   * Cloudflare Workers Builds a connect-and-go target rather than a config
   * somebody has to write. Quartz ships one; jotter does not.
   */
  hasWranglerConfig: boolean
}

export interface Starter {
  id: StarterId
  name: string
  /** One line: what it is, and who it suits. */
  summary: string
  /** The "Use this template" repository. Public, and template-enabled. */
  repoUrl: string
  docsUrl?: string
  recommended?: boolean
  /** Shown wherever this starter is chosen, not only where it is picked. */
  caution?: string
  build: StarterBuild
}

/**
 * Order is the order of the picker, and Quartz leads because it is the one we
 * recommend.
 *
 * Quartz keeps the recommendation on evidence rather than seniority: it is the
 * starter `npm run verify` builds for real against a stand-in bucket on every
 * commit, and the one whose `wrangler.jsonc` makes every supported host a
 * connect-and-go target. jotter is listed as a peer rather than as an
 * experiment, because it is public, template-enabled and passes its own suite;
 * what it is not yet is covered by *this* repository's build verification.
 */
export const STARTERS: readonly Starter[] = [
  {
    id: 'quartz',
    name: 'Open Publish Quartz',
    summary: 'The reference starter. A Quartz fork, built and checked end to end on every commit here.',
    repoUrl: 'https://github.com/navidkashani/open-publish-quartz',
    recommended: true,
    build: { command: 'npm run build', outputDir: 'public', hasWranglerConfig: true },
  },
  {
    id: 'jotter',
    name: 'jotter',
    summary: 'An Astro theme, designed rather than generated. Wikilinks resolve the way Obsidian resolves them.',
    repoUrl: 'https://github.com/navidkashani/jotter',
    docsUrl: 'https://github.com/navidkashani/jotter/blob/main/docs/open-publish.md',
    // Stated on the row, before the choice is made, the same way Wasabi's
    // deletion charge is: it is one extra step on exactly one host, and finding
    // it afterwards means redoing the hosting step.
    caution: 'Ships no wrangler.jsonc, so Cloudflare Workers Builds needs one written by hand. Pages does not.',
    build: { command: 'npm run build', outputDir: 'dist', hasWranglerConfig: false },
  },
]

/**
 * The fallback is the *first* entry, not the last.
 *
 * `hostById` falls back to its last, because that catalogue ends in a
 * deliberate escape hatch ("Another host") that matches anything. There is no
 * such thing here: an unknown starter id is a stale or corrupt setting, and the
 * safe answer to it is the starter this repository verifies.
 */
const FALLBACK = STARTERS[0] as Starter

/** Never throws. An id we do not know is a label problem, not a publish problem. */
export function starterById(id: string | undefined): Starter {
  return STARTERS.find((starter) => starter.id === id) ?? FALLBACK
}

export function isStarterId(value: unknown): value is StarterId {
  return typeof value === 'string' && STARTERS.some((starter) => starter.id === value)
}
