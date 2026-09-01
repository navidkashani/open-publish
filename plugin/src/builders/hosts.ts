/**
 * The hosting catalogue: presentation, defaults and warnings, and nothing else.
 *
 * The rule this file lives by is the same one `destinations/providers.ts` lives
 * by: **none of it reaches the wire**. `WebhookBuilder` keeps receiving the
 * `WebhookConfig` it always has. The deploy hook URL stays the only thing
 * posted and the site URL the only thing polled. A host id is a label, a set of
 * instructions, and the difference between telling a Netlify user about their
 * own free plan and telling them about Cloudflare's. The system stays fully
 * correct if that id is missing, stale, or flatly wrong.
 *
 * There is nothing to compose here, unlike storage: a deploy hook URL is opaque
 * and has to be pasted. So the id is *inferred* from the pasted URL and never
 * kept as a second source of truth about it.
 *
 * One type-only import, erased before anything runs, and no value imports. This
 * is a table plus four pure functions, so it runs under plain Node and the
 * tests need no DOM, no Obsidian, and no network.
 */

import type { StarterBuild } from './starters.ts'

export type HostId = 'cloudflare-pages' | 'cloudflare-workers' | 'netlify' | 'vercel' | 'other'

export interface Host {
  id: HostId
  name: string
  /** One line: what the free plan gives you. */
  summary: string
  recommended?: boolean
  /** Shown wherever this host is chosen, not only where it is picked. */
  caution?: string
  /**
   * Matched against a pasted deploy hook URL, anchored, `https` only.
   *
   * Anchoring is the whole safety story: without it
   * `https://api.netlify.com.attacker.net/build_hooks/x` would be labelled
   * Netlify and shown Netlify's advice. Null is the escape hatch, which matches
   * nothing and is reached by falling through.
   */
  hookPattern: RegExp | null
  /** How the docs table writes this hook URL. Kept in step by a test. */
  docsHook: string | null
  /**
   * The variable this host sets for the site's own address, read by
   * `starters/quartz/scripts/lib/site-url.mjs`. Null means it sets none, which
   * is a build failure there rather than a silently wrong site.
   */
  siteUrlVariable: string | null
  /**
   * Shown under the Site URL field on the hosts that report no address of their
   * own, where filling this field in is not on its own enough.
   */
  siteUrlNote?: string
  siteUrlExample: string
  /** What the throttle row says about this host's build budget. */
  allowance: string
  /**
   * The Notify tier: a persistent panel beside the two controls that spend the
   * allowance. Only for the hosts where a busy afternoon can cost the month.
   */
  allowanceNotice?: string
  /** Whether `_redirects` and `_headers` are read from the output directory. */
  readsRedirectFiles: boolean
  /** What this host calls the thing the variables go on. */
  projectNoun: string
  /**
   * Step 4 of the setup guide, in this host's own words.
   *
   * Takes the chosen starter's build rather than naming a directory, because
   * "Output directory: public" is true of Quartz and wrong for an Astro
   * starter, and a host told the wrong one deploys an empty directory and calls
   * it a success. Each host composes it into its own vocabulary.
   */
  setup: (build: StarterBuild) => string[]
  /** Step 5 of the setup guide: where the deploy hook lives. */
  hookSetup: string[]
  /**
   * Appended when the host turns a build request down.
   *
   * The default advice, "it may have been deleted", is right for a hook that
   * really is gone and actively misleading on a host whose free plan simply
   * stopped allowing builds this month.
   */
  rejectedHint: string
  consoleUrl?: string
  docsUrl?: string
}

/**
 * Order matters twice: it is the order of the picker, and Pages leads because
 * it is the one we recommend.
 *
 * Pages keeps the recommendation even though Workers Builds has the larger
 * allowance and Cloudflare's own investment. Two real differences are left, and
 * the second one arrived with the second starter. Workers Builds reports no
 * site address, so OP_SITE_URL has to be set by hand or the build stops. And
 * only a starter shipping a `wrangler.jsonc` makes it connect-and-go at all,
 * so `setup` below asks the starter rather than assuming. Both starters ship
 * one now, which removes the second difference but not the first: the address
 * still has to be set by hand, and one extra step on the recommended path is
 * one too many.
 *
 * Netlify is listed rather than left out, for the same reason Wasabi is listed
 * in the storage catalogue. Omitting it does not stop anyone using it; it only
 * means they meet a 20-deploy month with no warning at all.
 */
export const HOSTS: readonly Host[] = [
  {
    id: 'cloudflare-pages',
    name: 'Cloudflare Pages',
    summary: '500 builds a month, one at a time.',
    recommended: true,
    // Cloudflare's Pages deploy hooks page shows this URL only in a screenshot,
    // so the shape below is observed rather than documented, and the docs say
    // so rather than claiming it as vendor fact. It is checked against a live
    // deploy hook, which is also where the id character class comes from: the
    // id is a UUID, so hyphens have to be allowed or the host we recommend
    // would be labelled "Another host" for everybody using it.
    hookPattern: /^https:\/\/api\.cloudflare\.com\/client\/v4\/pages\/webhooks\/deploy_hooks\/[A-Za-z0-9._-]+$/i,
    docsHook: 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<hook-id>',
    siteUrlVariable: 'CF_PAGES_URL',
    siteUrlExample: 'https://my-notes.pages.dev',
    allowance: "Cloudflare Pages' free plan allows 500 builds a month and one at a time.",
    readsRedirectFiles: true,
    projectNoun: 'Pages project',
    setup: (build) => [
      'In Cloudflare, go to Workers & Pages → Create → Pages → Connect to Git, and pick the repository you just made.',
      `Framework preset: None. Build command: ${build.command}. Output directory: ${build.outputDir}.`,
      'Open Settings → Environment variables and add the variables below, for both Production and Preview.',
      'Mark OP_SECRET_ACCESS_KEY as encrypted.',
    ],
    hookSetup: [
      'In your Pages project, go to Settings → Builds & deployments → Deploy hooks.',
      'Create a hook for the branch your site is built from, usually main, and copy the URL.',
      'Paste it below, along with the site address Cloudflare gave you.',
    ],
    rejectedHint: 'Create a new deploy hook and paste the new URL into settings.',
    consoleUrl: 'https://dash.cloudflare.com/?to=/:account/pages',
    docsUrl: 'https://developers.cloudflare.com/pages/configuration/deploy-hooks/',
  },
  {
    id: 'cloudflare-workers',
    name: 'Cloudflare Workers',
    summary: '3,000 build minutes a month.',
    caution: 'You have to set your own site address.',
    hookPattern: /^https:\/\/api\.cloudflare\.com\/client\/v4\/workers\/builds\/deploy_hooks\/[A-Za-z0-9._-]+$/i,
    docsHook: 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<hook-id>',
    // The bug behind the caution above: Workers Builds injects CI, WORKERS_CI
    // and three more, and no address variable at all. The build now stops and
    // says so rather than writing the feed and the sitemap for example.com.
    siteUrlVariable: null,
    siteUrlNote:
      'Workers Builds does not report this address to the build. Set OP_SITE_URL to the same value in your ' +
      'build variables, or the build stops.',
    siteUrlExample: 'https://my-notes.workers.dev',
    allowance: "Cloudflare Workers' free plan allows 3,000 build minutes a month and one build at a time.",
    readsRedirectFiles: true,
    projectNoun: 'Worker',
    setup: (build) => [
      'In Cloudflare, go to Workers & Pages → Create → Import a repository, and pick the repository you just made.',
      ...(build.hasWranglerConfig
        ? [
            `Build command: ${build.command}. Deploy command: leave the default. The rest comes from wrangler.jsonc in the repository.`,
            'Edit the "name" in wrangler.jsonc to match the Worker you just created. Builds fail when the two disagree.',
          ]
        : [
            `Build command: ${build.command}.`,
            // Said plainly rather than hidden, and with the way out named. The
            // alternative is a build that succeeds and serves nothing.
            //
            // No starter in the catalogue reaches this branch today: both ship
            // a config. It stays because `hasWranglerConfig` is the starter's
            // answer to give rather than this table's to assume, and a third
            // starter is free to answer no. `hosts.test.mjs` exercises it with
            // a literal build for that reason, since going through the
            // catalogue would leave it silently untested the moment the last
            // starter without a config gained one, which is what happened.
            `This starter ships no wrangler.jsonc, so write one that serves ${build.outputDir} as static assets, or use Cloudflare Pages instead, which needs no such file.`,
          ]),
      'Open Settings → Variables and Secrets and add the variables below.',
      'Add OP_SECRET_ACCESS_KEY as a secret rather than a plain variable.',
      'Set OP_SITE_URL to your site address. Workers Builds does not provide one, and without it the build stops.',
    ],
    hookSetup: [
      'In your Worker, go to Settings → Builds → Deploy hooks.',
      'Create a hook for the branch your site is built from, usually main, and copy the URL.',
      'Paste it below, along with the address your Worker serves the site at.',
    ],
    rejectedHint: 'Create a new deploy hook and paste the new URL into settings.',
    consoleUrl: 'https://dash.cloudflare.com/?to=/:account/workers',
    docsUrl: 'https://developers.cloudflare.com/workers/ci-cd/builds/',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    summary: 'About 20 deploys a month on the free plan.',
    caution: 'After that your site stops updating until the next month.',
    hookPattern: /^https:\/\/api\.netlify\.com\/build_hooks\/[A-Za-z0-9._-]+$/i,
    docsHook: 'https://api.netlify.com/build_hooks/<hook-id>',
    siteUrlVariable: 'URL',
    siteUrlExample: 'https://my-notes.netlify.app',
    allowance:
      "Netlify's free plan covers about 20 site updates a month, and a minimum wait is no protection against a monthly allowance.",
    // The Notify tier. Netlify is the one host where our own default walks
    // straight into the free plan: five minutes between builds permits about
    // 8,600 a month against an allowance of roughly 20. The honest advice is
    // not "raise the interval", it is "choose when to spend one".
    allowanceNotice:
      "Netlify's free plan covers about 20 site updates a month. After that your site stops updating until the " +
      'next month. Turning off "Build after publishing" lets you choose when to spend one.',
    readsRedirectFiles: true,
    projectNoun: 'Netlify site',
    setup: (build) => [
      'In Netlify, choose Add new site → Import an existing project, and pick the repository you just made.',
      `Build command: ${build.command}. Publish directory: ${build.outputDir}.`,
      'Open Site configuration → Environment variables and add the variables below.',
      'Mark OP_SECRET_ACCESS_KEY as a secret so it is not shown again.',
    ],
    hookSetup: [
      'In your site, go to Site configuration → Build & deploy → Build hooks → Add build hook.',
      'Choose the branch your site is built from, usually main, and copy the URL.',
      'Paste it below, along with the address Netlify gave you.',
    ],
    // Scenario 12: Netlify answers the hook with an error once builds are
    // disabled, and does not document which status. Sending someone off to
    // recreate a hook that is fine is the worse of the two wrong answers.
    rejectedHint:
      'Either the deploy hook was deleted, or this month\'s build allowance is used up. Check your Netlify billing page before recreating the hook.',
    consoleUrl: 'https://app.netlify.com',
    docsUrl: 'https://docs.netlify.com/build/configure-builds/build-hooks/',
  },
  {
    id: 'vercel',
    name: 'Vercel',
    summary: '100 deploys a day.',
    caution: 'Renamed pages will not redirect unless you add a vercel.json.',
    hookPattern: /^https:\/\/api\.vercel\.com\/v\d+\/integrations\/deploy\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/i,
    docsHook: 'https://api.vercel.com/v1/integrations/deploy/<project-id>/<hash>',
    siteUrlVariable: 'VERCEL_PROJECT_PRODUCTION_URL',
    siteUrlExample: 'https://my-notes.vercel.app',
    allowance: "Vercel's free plan allows 100 deploys a day, and 60 deploy hook triggers an hour.",
    // The Log tier: one line here and one in the docs. Vercel reads neither
    // `_redirects` nor `_headers`, so renames do not redirect and the marker is
    // not `no-store`. The cache-busting parameter on every poll already covers
    // most of the staleness, which is why this is a line and not a panel.
    readsRedirectFiles: false,
    projectNoun: 'Vercel project',
    setup: (build) => [
      'In Vercel, choose Add New → Project, and pick the repository you just made.',
      `Framework preset: Other. Build command: ${build.command}. Output directory: ${build.outputDir}.`,
      'Open Settings → Environment Variables and add the variables below.',
      'Mark OP_SECRET_ACCESS_KEY as Sensitive.',
    ],
    hookSetup: [
      'In your project, go to Settings → Git → Deploy Hooks.',
      'Create a hook for the branch your site is built from, usually main, and copy the URL.',
      'Paste it below, along with the address Vercel gave you.',
    ],
    rejectedHint: 'Create a new deploy hook and paste the new URL into settings.',
    consoleUrl: 'https://vercel.com/dashboard',
    docsUrl: 'https://vercel.com/docs/deploy-hooks',
  },
  {
    id: 'other',
    name: 'Another host',
    summary: 'Anything that builds a Git repository and gives you a deploy hook URL.',
    hookPattern: null,
    docsHook: null,
    // Null because this host reports no address of its own, which is what this
    // field means. It used to say 'OP_SITE_URL', reading the field as "where
    // the address comes from" rather than "what the host provides", and the
    // effect was that the escape hatch, where every unrecognised hook lands,
    // was the one host whose environment block omitted the very variable its
    // own instructions tell you to set.
    siteUrlVariable: null,
    siteUrlNote:
      'If your host does not report its own address to the build, set OP_SITE_URL to the same value in your ' +
      'build variables. Otherwise the feed, the sitemap and the 404 page point at the wrong place.',
    siteUrlExample: 'https://notes.example.com',
    allowance: 'Most free plans limit how many builds a month you get. Check yours before turning the wait down.',
    readsRedirectFiles: false,
    projectNoun: 'site build',
    setup: (build) => [
      'Connect the repository you just made to your host.',
      `Build command: ${build.command}. Output directory: ${build.outputDir}.`,
      'Add the variables below wherever your host keeps build environment variables.',
      'Mark OP_SECRET_ACCESS_KEY as a secret if your host offers one.',
      'Set OP_SITE_URL to your site address, so the feed, the sitemap and the 404 page point at the right place.',
    ],
    hookSetup: [
      'Find the deploy hook, build hook or build trigger in your host and create one for the branch your site is built from.',
      'Copy the URL and paste it below, along with your site address.',
      'If your host reads neither _redirects nor _headers, renamed pages will not redirect.',
    ],
    rejectedHint:
      "Either the deploy hook was deleted, or your host has stopped allowing builds. Check your host's build settings before recreating the hook.",
  },
]

const FALLBACK = HOSTS[HOSTS.length - 1] as Host

/** Never throws. An id we do not know is a label problem, not a publish problem. */
export function hostById(id: string | undefined): Host {
  return HOSTS.find((host) => host.id === id) ?? FALLBACK
}

export function isHostId(value: unknown): value is HostId {
  return typeof value === 'string' && HOSTS.some((host) => host.id === value)
}

/**
 * Everything before the query string, which is where the identifying part is.
 *
 * Netlify hooks are routinely used with `?trigger_branch=`, and a query string
 * says nothing about which host this is. Stripping it cannot weaken the match,
 * because the pattern is anchored on the scheme, the host and the path.
 */
function hookPath(url: string): string {
  return url.trim().split(/[?#]/)[0]?.replace(/\/+$/, '') ?? ''
}

/**
 * Which host a deploy hook URL belongs to, by exact pattern match only.
 *
 * Everything else is "Another host", including a hook behind a relay. That is
 * the point: inference is read-only, so a near miss costs a label, never a
 * rewritten configuration and never a changed limit.
 */
export function inferHost(url: string | undefined): HostId {
  const cleaned = hookPath(url ?? '')
  if (!cleaned) return 'other'
  for (const host of HOSTS) {
    if (host.hookPattern?.test(cleaned)) return host.id
  }
  return 'other'
}

/**
 * The hint for a build request the host turned down, in terms of the host
 * actually in use.
 *
 * Inferred from the URL rather than passed in, exactly as `missingBucketHint`
 * infers a provider from the endpoint. That keeps the hook URL the single
 * source of truth and keeps the host id out of `WebhookConfig`.
 */
export function rejectedHookHint(url: string | undefined): string {
  return hostById(inferHost(url)).rejectedHint
}

/** How the docs table writes this host's hook URL. Kept in step by a test. */
export function docsHook(id: HostId): string | null {
  return hostById(id).docsHook
}
