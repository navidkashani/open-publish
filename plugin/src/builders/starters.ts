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
   * somebody has to write.
   *
   * Both starters ship one today, so nothing in this table answers `false` any
   * more. The field stays because the answer is the starter's to give rather
   * than this table's to assume, and a third starter is free to give a
   * different one.
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
 * Order is the order of the picker, and jotter leads because it is the one we
 * recommend.
 *
 * The recommendation moved here from Quartz when jotter shipped a
 * `wrangler.jsonc`, because that file was the last thing making it the longer
 * road: both starters are now connect-and-go on every host this plugin names,
 * so what is left to choose between is how the site looks. jotter is designed
 * rather than generated, and it resolves wikilinks the way Obsidian does.
 *
 * The cost of moving it is real, and belongs here rather than nowhere. Quartz
 * is the starter `npm run verify` builds for real against a stand-in bucket on
 * every commit *in this repository*; jotter is not covered by that at all. It
 * passes its own suite in its own repository, including a test tying its
 * `wrangler.jsonc` to the directory its build actually writes, which is the
 * exact failure this table exists to prevent. That is good evidence. It is not
 * the same evidence, and anyone weighing the two should be able to find out
 * which of them this repository can vouch for.
 */
export const STARTERS: readonly Starter[] = [
  {
    id: 'jotter',
    name: 'jotter',
    summary: 'An Astro theme, designed rather than generated. Wikilinks resolve the way Obsidian resolves them.',
    repoUrl: 'https://github.com/navidkashani/jotter',
    docsUrl: 'https://github.com/navidkashani/jotter/blob/main/docs/open-publish.md',
    recommended: true,
    build: { command: 'npm run build', outputDir: 'dist', hasWranglerConfig: true },
  },
  {
    id: 'quartz',
    name: 'Open Publish Quartz',
    summary: 'The reference starter. A Quartz fork, built and checked end to end on every commit here.',
    repoUrl: 'https://github.com/navidkashani/open-publish-quartz',
    build: { command: 'npm run build', outputDir: 'public', hasWranglerConfig: true },
  },
]

/**
 * The fallback is the *first* entry, not the last.
 *
 * `hostById` falls back to its last, because that catalogue ends in a
 * deliberate escape hatch ("Another host") that matches anything. There is no
 * such thing here: an unknown starter id is a stale or corrupt setting, and the
 * safe answer to it is the one the list recommends, which is the entry leading
 * it.
 */
const FALLBACK = STARTERS[0] as Starter

/** Never throws. An id we do not know is a label problem, not a publish problem. */
export function starterById(id: string | undefined): Starter {
  return STARTERS.find((starter) => starter.id === id) ?? FALLBACK
}

export function isStarterId(value: unknown): value is StarterId {
  return typeof value === 'string' && STARTERS.some((starter) => starter.id === value)
}
