/**
 * Work out the site's absolute URL from whatever the host provides.
 *
 * Quartz needs this for RSS, the sitemap and the 404 page. Its own fallback is
 * `cfg.baseUrl ?? "example.com"`. Note `??`, which only catches null and
 * undefined. Hand it an empty string and the fallback is skipped, giving
 * `new URL("https://")` and a build that dies with "Invalid URL" and no clue
 * which setting caused it.
 *
 * So this returns `undefined` rather than `''` when nothing is configured, and
 * knows the conventional variable for each host so the URL is actually right
 * rather than merely non-empty.
 */

/** Quartz wants a bare host with no scheme and no trailing slash. */
function normalise(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Workers Builds is the one host that gives us nothing to work with.
 *
 * It injects `CI`, `WORKERS_CI`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA`
 * and `WORKERS_CI_BRANCH`, and no URL variable at all. Every lookup below misses,
 * Quartz applies its own `example.com`, and the feed, the sitemap and the 404
 * page ship pointing at a domain the user does not own. Nothing fails, which is
 * the problem: a build that stops with a fixable sentence beats a site that is
 * quietly wrong in the three places nobody checks after a deploy.
 */
export const NO_SITE_URL_ON_WORKERS =
  'This build is running on Cloudflare Workers Builds, which does not tell the build what address ' +
  'the site is served at. Without one, the feed, the sitemap and the 404 page would all be written ' +
  'for example.com. Set OP_SITE_URL to your own address, for example https://notes.example.com, ' +
  'under Settings > Variables and Secrets on the Worker, then build again.'

/**
 * Cloudflare Pages' `CF_PAGES_URL` on a deployment that has no alias: a fresh
 * eight-hex-digit subdomain, minted per deploy.
 *
 * `2f8bfad6.notes.pages.dev`, never `notes.pages.dev`. Matching on the shape is
 * the only way to tell them apart, because Pages injects exactly five variables
 * (`CI`, `CF_PAGES`, `CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`, `CF_PAGES_URL`)
 * and **none of them carries the stable `<project>.pages.dev` alias**. There is
 * nothing to derive it from, so it has to be asked for.
 */
const PAGES_DEPLOYMENT_HOST = /^https?:\/\/[0-9a-f]{8}\./i

/**
 * The second failure in this file, and it stops the build for the same reason
 * the first one does: the available answer is worse than no answer.
 *
 * Cloudflare serves a deployment's own hash host with `x-robots-tag: noindex`.
 * Handed to Quartz as `baseUrl` it becomes every page's canonical link and
 * `og:url`, every entry in the sitemap and the `Sitemap:` line in `robots.txt`:
 * the whole site telling search engines that the real version of each page
 * lives at a host they are forbidden to index. Pages dropping out of the index
 * is the documented outcome of that contradiction, which is the exact opposite
 * of what preserving somebody's URLs was for.
 *
 * A warning would not do. This shipped to a production site behind a build log
 * that said nothing, which is precisely how a warning performs.
 */
export const NO_SITE_URL_ON_PAGES =
  'This build is running on Cloudflare Pages, and the only address it was given (CF_PAGES_URL) ' +
  'is this deployment\'s own hash subdomain, which changes on every deploy and which Cloudflare ' +
  'serves with "x-robots-tag: noindex". Used as the site address it would put a canonical link, ' +
  'an og:url and a sitemap on every page naming a host search engines are forbidden to index, ' +
  'and the usual result of that contradiction is the site dropping out of the index. Pages ' +
  'injects no variable carrying the stable <project>.pages.dev alias, so it cannot be worked ' +
  'out here. Set OP_SITE_URL to the address readers actually use, for example ' +
  'https://notes.example.com or https://<project>.pages.dev, under Settings > Variables and ' +
  'secrets in the Pages project, for the Production and Preview environments both, then deploy ' +
  'again.'

export function resolveBaseUrl(env = process.env) {
  // Set this yourself to override everything, e.g. for a custom domain.
  const explicit = normalise(env.OP_SITE_URL)
  if (explicit) return explicit

  if (PAGES_DEPLOYMENT_HOST.test(String(env.CF_PAGES_URL ?? '').trim())) {
    throw new Error(NO_SITE_URL_ON_PAGES)
  }

  const resolved =
    normalise(env.CF_PAGES_URL) ??                                   // Cloudflare Pages
    normalise(env.DEPLOY_PRIME_URL) ??                               // Netlify (branch/deploy)
    normalise(env.URL) ??                                            // Netlify (production)
    normalise(env.VERCEL_PROJECT_PRODUCTION_URL) ??                  // Vercel (stable)
    normalise(env.VERCEL_URL) ??                                     // Vercel (per-deployment)
    undefined
  if (resolved) return resolved

  if (normalise(env.WORKERS_CI)) throw new Error(NO_SITE_URL_ON_WORKERS)

  // Everywhere else, an unset address is a local build or a preview, and
  // `undefined` is what lets Quartz's own fallback do its job.
  return undefined
}
