# Other providers

The design needs only two things:

1. **Storage** that speaks the S3 API and supports `GET`, `PUT`, `HEAD` and
   `DELETE`. Conditional writes (`If-Match`) are strongly recommended.
2. **A host** that builds a Git repository, exposes environment variables, and
   offers a deploy hook URL.

Anything meeting both works. Cloudflare is the documented default, because the
free tiers are generous and both halves live in one dashboard.

## Storage

Pick one in **Settings → Storage** and the plugin fills in the endpoint, the
region and path-style addressing, leaving one blank to type. This table is for
reference, and for anyone configuring a build by hand.

| Provider | Endpoint | Region | Path style | Conditional writes |
|---|---|---|---|---|
| **Cloudflare R2** | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | on | yes |
| **Cloudflare R2 without keys** | your Worker's address | n/a | n/a | yes |
| **Amazon S3** | `https://s3.<region>.amazonaws.com` | the real region | off | yes |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | on | check at connect |
| **Wasabi** | `https://s3.<region>.wasabisys.com` | the real region | on | check at connect |
| **MinIO** (self-hosted) | your server URL | `us-east-1` | on | 2024-09-13 and later |
| **Other S3-compatible storage** | your provider's S3 API endpoint | usually `auto` | on | check at connect |

**Cloudflare R2 without keys** is the same R2 bucket reached a different way,
through a small Worker you deploy to your own account. The plugin holds one
bearer token instead of an access key and secret. Region and path style have no
meaning there. This route is R2-only. See [the gateway's
README](../gateway/README.md) to deploy it, and [security.md](security.md) for
what it does and does not fix.

Amazon S3 is the one entry with path style **off**, because AWS documents
path-style addressing as deprecated. Virtual-host addressing breaks TLS on a
bucket name containing a dot, so avoid dots in the name.

Use **Test connection** before going further. It performs a real PUT, GET,
compare and DELETE, then one write with a deliberately stale `If-Match` that a
correct provider has to reject. If a provider does not support conditional
writes, the plugin degrades to a read-then-warn check: publishing still works,
and two devices publishing at the same moment are less well protected. **Storage
self-test** also covers the first-publish guard.

### Two that fight this design

**Wasabi** bills a 90-day minimum storage duration, so **Clean up unused files**
costs money there rather than saving it. Wasabi works, and the plugin says this
wherever you choose it, but leave the cleanup alone.

**Storj** charges per segment, which penalises many small objects. This design
stores many small objects, so it is a poor fit even though the API works.

## Hosting

Pick one in **Settings → Site build** and the plugin labels the copy, the build
budget and the warnings for the host you use. The choice is only ever a label:
the deploy hook URL is the one thing sent, and the site address the one thing
polled.

Both starters build with `npm run build`. **The output directory differs, and
getting it wrong is the one mistake here that does not announce itself:** a host
told the wrong directory deploys an empty one and reports success.

| Starter | Build command | Output directory |
|---|---|---|
| **jotter** (recommended) | `npm run build` | `dist` |
| **Open Publish Quartz** | `npm run build`, which runs `node scripts/fetch-content.mjs && node scripts/build-site.mjs && node scripts/finalize.mjs` | `public` |

Environment variables are the same for both: `OP_ENDPOINT`, `OP_BUCKET`,
`OP_REGION`, `OP_ACCESS_KEY_ID`, `OP_SECRET_ACCESS_KEY`, plus `OP_PREFIX` if you
use one, and `OP_SITE_URL` where the host provides no address of its own.

| Host | Deploy hook URL | Free build budget | `_redirects` and `_headers` | Site address variable |
|---|---|---|---|---|
| **Cloudflare Pages** | `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<hook-id>` | 500 builds a month, 1 at a time | native | `CF_PAGES_URL` |
| **Cloudflare Workers** | `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/<hook-id>` | 3,000 build minutes a month, 1 at a time | native | none, set `OP_SITE_URL` |
| **Netlify** | `https://api.netlify.com/build_hooks/<hook-id>` | 300 credits a month, about 20 deploys | native | `URL`, `DEPLOY_PRIME_URL` |
| **Vercel** | `https://api.vercel.com/v1/integrations/deploy/<project-id>/<hash>` | 100 deploys a day, 60 hook triggers an hour | neither | `VERCEL_PROJECT_PRODUCTION_URL` |
| **Another host** | whatever your host gives you | unknown | unknown | set `OP_SITE_URL` |

All four accept `POST`, none needs an authorization header, and Vercel also
accepts `GET`. The plugin recognises a pasted hook URL by matching these shapes
exactly, so a hook behind a relay is simply "Another host", which costs a label
and nothing else. One caveat on the Pages row: Cloudflare's
[deploy hooks page](https://developers.cloudflare.com/pages/configuration/deploy-hooks/)
shows that URL only in a screenshot. Everything else comes from vendor docs.

### The site address

The feed, the sitemap and the 404 page need an absolute address. Each host names
its own variable and the build reads whichever it finds. Two variables of our own
override that:

| Variable | When you need it |
|---|---|
| `OP_SITE_URL` | A custom domain, Cloudflare Workers Builds, or any host that sets no address of its own. Without it the feed and sitemap keep the vendor host name, or the site is built as `example.com`. |
| `OP_SITE_ROOT` | A site served from a sub-path, e.g. `https://example.com/notes/`. Set it to `/notes` so internal links resolve. |

Adding a custom domain in your host's dashboard is not enough on its own. The
pages serve from it, and the feed and sitemap keep pointing at the `pages.dev`
or `netlify.app` name until `OP_SITE_URL` says otherwise.

### Cloudflare Pages

The documented default. See [setup-cloudflare.md](setup-cloudflare.md).

### Cloudflare Workers Builds

The forward-looking Cloudflare option. Cloudflare's own
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
says Pages continues to be supported, and that new investment goes to Workers.

Same repository, same build command, same variables. Deploy hooks arrived in
[April 2026](https://developers.cloudflare.com/changelog/post/2026-04-01-deploy-hooks/):
a URL, `POST`, no authorization header, 10 builds a minute per Worker.

Workers Builds sets no URL variable at all, so **set `OP_SITE_URL` yourself**.
Forget it and the build stops rather than quietly building a site addressed as
`example.com`.

Both starters ship the `wrangler.jsonc` a Worker needs, so either is
connect-and-go here. Each is assets-only with no `main`:

| | Assets directory | 404 | Trailing slashes |
|---|---|---|---|
| **jotter** | `./dist` | `404-page`, from `src/pages/404.astro` | `drop-trailing-slash`, because Astro writes `dist/notes/index.html` while the links, canonical, sitemap and search all spell it `/notes` |
| **Open Publish Quartz** | `./public` | `404-page` | `auto-trailing-slash`, so the extensionless links Quartz writes resolve to its flat `.html` files |

**Change the `name` in it to match your Worker.** Workers Builds fails the build
when the two disagree, and the error does not say which name it wanted.

Pages ignores that file, because it carries no `pages_build_output_dir`, so one
repository serves both hosts. Every Pages build prints this warning and then
succeeds:

```
A Wrangler configuration file was found but it does not appear to be valid.
Did you mean to use wrangler.toml to configure Pages? ... Skipping file and continuing.
```

Adding `pages_build_output_dir` to silence it would make the file the source of
truth for the Pages project's build settings, overriding the dashboard.

### Node version

Both starters pin Node with a `.node-version` file. Leave it alone unless you
mean to move it. The hosts disagree about where to look: Cloudflare Pages,
Workers Builds and Netlify read `.node-version`, and **Pages does not read
`package.json` engines at all**, while Vercel reads `engines`. Both files ship
saying the same version, so the same template cannot build on two different Node
versions depending on who builds it.

### Netlify

Build command `npm run build`, publish directory `public`. Environment variables
under **Site configuration → Environment variables**. Deploy hook under **Build &
deploy → Build hooks**.

Netlify's free plan is
[credit-based](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans/):
roughly 300 credits a month at about 15 per production deploy, so **around 20
deploys a month**. A minimum wait between builds cannot protect that, because
five minutes still permits about 8,600 builds a month. Turn *Build after
publishing* off and start builds when you mean to. Run out and the site keeps
serving what it has but stops updating, the deploy hook returns an error, and the
plugin reports that your host turned the request down.

Netlify reads `_redirects` and `_headers` from the publish directory natively.

### Vercel

Framework preset **Other**, build command `npm run build`, output directory
`public`. Environment variables under **Settings → Environment Variables**.
Deploy hook under **Settings → Git → Deploy Hooks**.

Vercel reads neither `_redirects` nor `_headers`. Rename redirects and the
`no-store` rule on `/_publish.json` will not apply, so the plugin may briefly
report a stale version as live. Translate them into `vercel.json` if you need
them; the cache-busting parameter on each poll covers most of the risk.

### GitHub Pages

Not supported. GitHub has no deploy hook: builds start through
`repository_dispatch` or `workflow_dispatch`, and both require an
`Authorization` header carrying a token. The plugin sends no headers at all with
a deploy hook, by design. You would need a small relay of your own, holding the
token and exposing a plain URL, the same shape as the [Worker
gateway](../gateway/README.md).

### A hook for the branch your site serves

Whichever host you pick, create the deploy hook for the branch the live site is
built from. A hook scoped to another branch builds a preview address while the
plugin polls the production one, so a publish waits the full ten minutes before
saying anything.

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
