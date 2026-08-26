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

export function resolveBaseUrl(env = process.env) {
  return (
    // Set this yourself to override everything, e.g. for a custom domain.
    normalise(env.OP_SITE_URL) ??
    normalise(env.CF_PAGES_URL) ??                                   // Cloudflare Pages
    normalise(env.DEPLOY_PRIME_URL) ??                               // Netlify (branch/deploy)
    normalise(env.URL) ??                                            // Netlify (production)
    normalise(env.VERCEL_PROJECT_PRODUCTION_URL) ??                  // Vercel (stable)
    normalise(env.VERCEL_URL) ??                                     // Vercel (per-deployment)
    undefined
  )
}
