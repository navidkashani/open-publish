# Other providers

The design depends on only two things:

1. **Storage** that speaks the S3 API and supports `GET`, `PUT`, `HEAD` and
   `DELETE`. Conditional writes (`If-Match`) are strongly recommended.
2. **A host** that builds a Git repository, exposes environment variables, and
   offers a deploy hook URL.

Anything meeting both works. Cloudflare is documented as the default because the
free tiers are generous and both halves live in one dashboard.

## Storage

The plugin ships with this list built in. Pick one in **Settings > Storage** and
it fills in the endpoint, the region and path-style addressing for you, leaving
one blank to type. The table is here for reference, and for anyone configuring
the build by hand.

| Provider | Endpoint | Region | Path style | Conditional writes |
|---|---|---|---|---|
| **Cloudflare R2** | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | on | yes |
| **Amazon S3** | `https://s3.<region>.amazonaws.com` | the real region | off | yes |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | on | check at connect |
| **Wasabi** | `https://s3.<region>.wasabisys.com` | the real region | on | check at connect |
| **MinIO** (self-hosted) | your server URL | `us-east-1` | on | 2024-09-13 and later |
| **Other S3-compatible storage** | your provider's S3 API endpoint | usually `auto` | on | check at connect |

Amazon S3 is the one entry with path style **off**: AWS documents path-style
addressing as deprecated and virtual-host addressing as the form it is keeping.
The cost of virtual-host addressing is that a bucket name containing a dot
breaks TLS, so avoid dots in the name. Every other provider here is path-style,
which is why it is the default.

Use **Test connection** in the plugin before going further. It performs a real
PUT, GET, compare and DELETE, then one write with a deliberately stale
`If-Match` that a correct provider has to reject. A pass therefore means the
credentials genuinely have everything publishing needs, and tells you whether
two devices can publish safely.

If a provider does not support conditional writes, the plugin detects it at
runtime and degrades to a read-then-warn check. Publishing still works; the
protection against two devices publishing at the same moment is weaker. Run
**Storage self-test** in settings for the full picture, including the
first-publish guard that **Test connection** does not cover.

### Two that fight this design

**Wasabi** bills a 90-day minimum storage duration: delete an object sooner and
you still pay for the remaining days. Open Publish is content-addressed, so
**Clean up unused files** deletes orphaned objects, and on Wasabi that costs
money rather than saving it. Wasabi works, and the plugin says this wherever you
choose it, but leave the cleanup alone or expect the bill.

**Storj** charges per segment, which penalises many small objects. A
content-addressed vault is precisely many small objects, so it is a poor fit
even though the API works.

## Hosting

The plugin ships with this list built in. Pick one in **Settings > Site build**
and it labels the copy, the build budget and the warnings for the host you
actually use. The choice is only ever a label: the deploy hook URL is the one
thing sent, and the site address the one thing polled.

The starter's build command is:

```
node scripts/fetch-content.mjs && node scripts/build-site.mjs && node scripts/finalize.mjs
```

Output directory: `public`. Environment variables: `OP_ENDPOINT`, `OP_BUCKET`,
`OP_REGION`, `OP_ACCESS_KEY_ID`, `OP_SECRET_ACCESS_KEY`, plus `OP_PREFIX` if you
use one, and `OP_SITE_URL` where the host does not provide an address of its own.

| Host | Deploy hook URL | Free build budget | `_redirects` and `_headers` | Site address variable |
|---|---|---|---|---|
| **Cloudflare Pages** | `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<hook-id>` | 500 builds a month, 1 at a time | native | `CF_PAGES_URL` |
| **Cloudflare Workers** | `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<hook-id>` | 3,000 build minutes a month, 1 at a time | native | none, set `OP_SITE_URL` |
| **Netlify** | `https://api.netlify.com/build_hooks/<hook-id>` | 300 credits a month, about 20 deploys | native | `URL`, `DEPLOY_PRIME_URL` |
| **Vercel** | `https://api.vercel.com/v1/integrations/deploy/<project-id>/<hash>` | 100 deploys a day, 60 hook triggers an hour | neither | `VERCEL_PROJECT_PRODUCTION_URL` |
| **Another host** | whatever your host gives you | unknown | unknown | set `OP_SITE_URL` |

All four accept `POST`, none needs an authorization header, and Vercel also
accepts `GET`. The plugin recognises a pasted hook URL by matching it against
these shapes exactly, so a hook behind a relay or a proxy is simply "Another
host": a near miss costs a label and never changes a limit.

One caveat on the Cloudflare Pages row. Cloudflare's
[deploy hooks page](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)
shows the URL only in a screenshot rather than as text, so that path is what the
dashboard hands out rather than something Cloudflare documents. Everything else
in the table comes from the vendor's own docs.

### The site address

Quartz needs an absolute address for the feed, the sitemap and the 404 page.
Each host names its own variable, and the build reads whichever one it finds.
Two variables of our own override that:

| Variable | When you need it |
|---|---|
| `OP_SITE_URL` | A custom domain, Cloudflare Workers Builds, or any host that sets no address of its own. Without it the feed and the sitemap keep the vendor host name, or the site is built as `example.com`. |
| `OP_SITE_ROOT` | A site served from a sub-path, e.g. `https://example.com/notes/`. Set it to `/notes` so internal links resolve. |

Adding a custom domain in your host's dashboard is not enough on its own. The
pages will serve from it, but the feed and the sitemap keep pointing at the
`pages.dev` or `netlify.app` name until `OP_SITE_URL` says otherwise.

### Cloudflare Pages

The documented default. See [setup-cloudflare.md](setup-cloudflare.md).

### Cloudflare Workers Builds

The forward-looking Cloudflare option. Cloudflare's own
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
puts it plainly: Pages continues to be supported, but new investment,
optimisation and feature work go to Workers.

Same repository, same build command, same variables. Deploy hooks arrived in
[April 2026](https://developers.cloudflare.com/changelog/post/2026-04-01-deploy-hooks/):
a URL, `POST`, no authorization header, 10 builds a minute per Worker.

The one thing to get right is the address. Workers Builds sets `CI`,
`WORKERS_CI`, `WORKERS_CI_BUILD_UUID`, `WORKERS_CI_COMMIT_SHA` and
`WORKERS_CI_BRANCH`, and
[no URL variable at all](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
So **set `OP_SITE_URL` yourself**. If you forget, the build stops and says so,
which is deliberate: it used to build a site quietly addressed as `example.com`.

The starter ships the `wrangler.jsonc` a Worker needs: assets-only, no `main`,
`./public` as the assets directory, `404-page` handling for the 404 Quartz
emits, and `auto-trailing-slash` so the extensionless links Quartz writes
resolve to its flat `.html` files. Pages ignores that file, because it carries
no `pages_build_output_dir`, so one repository serves both.

**Change the `name` in it to match your Worker.** Workers Builds fails the build
when the two disagree, and the error does not say which name it wanted.

Pages keeps the recommendation anyway, for one reason rather than the old one:
Workers Builds reports no site address, so `OP_SITE_URL` is a required manual
step here and not needed at all there.

### Netlify

Build command `npm run build`, publish directory `public`. Environment variables
under **Site configuration → Environment variables**. Deploy hook under
**Build & deploy → Build hooks**.

Netlify's free plan is
[credit-based](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/):
roughly 300 credits a month at about 15 per production deploy, so **around 20
deploys a month**.

Worth being clear about what that means, because it is not what a minimum wait
protects against. Five minutes between builds still permits about 8,600 builds a
month. The limit that bites is the monthly one, and the only real defence is to
turn *Build after publishing* off and start builds when you mean to. The plugin
says so in a panel next to that switch rather than changing the setting for you.

Run out and the site keeps serving what it has, but stops updating: on the
legacy build-minutes plans
[builds stop and the site stays up](https://answers.netlify.com/t/what-happens-if-a-free-plan-exceeds-bandwidth-and-or-build-minutes-limit/16244),
and on the credit-based free plan the project is paused until the next cycle.
The deploy hook then returns an error, so the plugin reports that your host
turned the request down.

Netlify reads `_redirects` and `_headers` from the publish directory natively,
so both files work unchanged.

### Vercel

Framework preset **Other**, build command `npm run build`, output directory
`public`. Environment variables under **Settings → Environment Variables**.
Deploy hook under **Settings → Git → Deploy Hooks**.

Vercel does not read `_redirects` or `_headers`. Rename redirects and the
`no-store` rule on `/_publish.json` will not apply, which means the plugin may
briefly report a stale version as live. Translate them into `vercel.json` if you
need them; the cache-busting parameter on each poll covers most of the risk.

### GitHub Pages

Not directly supported, and the reason is worth stating rather than working
around. GitHub has no deploy hook: builds are started through
`repository_dispatch` or `workflow_dispatch`, and both require an
`Authorization` header carrying a token. The plugin sends **no headers at all**
with a deploy hook, by design, so there is nowhere to put one.

An earlier version of this page said to point the deploy hook URL at the GitHub
API "with a token". That never worked. To use GitHub Pages you need a small
relay that you own, holding the token and exposing a plain URL, which is the
same shape as the Worker gateway sketched in [security.md](security.md). A
GitHub token is also a far wider credential than a deploy hook URL, which is a
poor trade on its own terms.

### A hook for the branch your site serves

Whichever host you pick, create the deploy hook for the branch the live site is
built from. A hook scoped to some other branch builds a preview address while
the plugin polls the production one, so the check never matches and a publish
waits the full ten minutes before saying anything.

## Local testing with MinIO

Useful for trying the whole pipeline without a cloud account:

```bash
docker run -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address ":9001"
```

In the plugin: endpoint `http://localhost:9000`, region `us-east-1`, path-style
on, and the root credentials. Create a bucket in the console at
`http://localhost:9001` first. **Test connection** should pass.
