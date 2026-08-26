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

export function resolveBaseUrl(env = process.env) {
  const resolved =
    // Set this yourself to override everything, e.g. for a custom domain.
    normalise(env.OP_SITE_URL) ??
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
