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

/**
 * How a copy of a starter is made, and therefore the words the wizard uses.
 *
 * Both starters are `template` today, and the reasons differ, which is why this
 * is a field rather than a sentence in the wizard.
 *
 * **Quartz cannot be anything else.** `assemble.mjs` regenerates that repository
 * and force-pushes it, and a rewritten tip is the one thing GitHub's fork sync
 * cannot survive: every downstream merge would be against commits that no longer
 * exist.
 *
 * **jotter could be forked and deliberately is not recommended that way.** A
 * fork gets GitHub's native "Sync fork" button for free, which is genuinely
 * nicer, but it costs three things: a fork of a public repository is public for
 * ever (so a private site or a vault kept in the repository is out), you get one
 * fork per account per repository (so a second site cannot have one), and it is
 * a path nobody has yet run end to end. jotter ships its own update workflow
 * instead, which has none of those limits and has been run against a fresh
 * template copy, a conflict, and a repository already up to date.
 */
export type Acquisition = 'template' | 'fork'

export interface Starter {
  id: StarterId
  name: string
  /** One line: what it is, and who it suits. */
  summary: string
  /** The repository a copy is made from. Public, and template-enabled. */
  repoUrl: string
  docsUrl?: string
  recommended?: boolean
  /** Shown wherever this starter is chosen, not only where it is picked. */
  caution?: string
  acquisition: Acquisition
  /**
   * How a site made from this starter takes a *later* version of it, once one
   * exists, or `undefined` where there is no answer better than a terminal.
   *
   * The one thing a starter can offer here that this plugin cannot is a button
   * inside the user's own repository, so what this holds is where to find it.
   */
  updates?: { label: string; hint: string }
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
 * `wrangler.jsonc` to the directory its build actually writes and a `--full`
 * pass that fetches a snapshot, builds the site and asserts the addresses it
 * serves. That is good evidence. It is not the same evidence, and anyone
 * weighing the two should be able to find out which of them this repository can
 * vouch for. See `docs/architecture.md` for exactly where the line falls.
 */
export const STARTERS: readonly Starter[] = [
  {
    id: 'jotter',
    name: 'jotter',
    summary: 'An Astro theme, designed rather than generated. Wikilinks resolve the way Obsidian resolves them.',
    repoUrl: 'https://github.com/navidkashani/jotter',
    docsUrl: 'https://github.com/navidkashani/jotter/blob/main/docs/open-publish.md',
    recommended: true,
    acquisition: 'template',
    updates: {
      label: 'Actions → Update theme → Run workflow',
      hint: 'jotter ships a workflow that merges a new version onto a branch in your own repository and gives you a pull request to review.',
    },
    build: { command: 'npm run build', outputDir: 'dist', hasWranglerConfig: true },
  },
  {
    id: 'quartz',
    name: 'Open Publish Quartz',
    summary: 'The reference starter. A Quartz fork, built and checked end to end on every commit here.',
    repoUrl: 'https://github.com/navidkashani/open-publish-quartz',
    acquisition: 'template',
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

/**
 * Step 2 of the setup guide, in the words the chosen starter's acquisition
 * needs. The shape `hosts.ts` uses for `setup(build)`, one table over.
 */
export function acquireSteps(starter: Starter): string[] {
  return starter.acquisition === 'fork'
    ? [
        'Choose "Fork" → "Create fork".',
        'Give it any name. There is nothing to clone and nothing to install locally.',
      ]
    : [
        'Choose "Use this template" → "Create a new repository".',
        'Give it any name. There is nothing to clone and nothing to install locally.',
      ]
}

/** What the link to the repository should say, which follows the same choice. */
export function acquireLabel(starter: Starter): string {
  return starter.acquisition === 'fork'
    ? `Fork ${starter.name}`
    : `Open the ${starter.name} template`
}
