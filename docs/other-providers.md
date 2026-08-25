# Other providers

The design depends on only two things:

1. **Storage** that speaks the S3 API and supports `GET`, `PUT`, `HEAD` and
   `DELETE`. Conditional writes (`If-Match`) are strongly recommended.
2. **A host** that builds a Git repository, exposes environment variables, and
   offers a deploy hook URL.

Anything meeting both works. Cloudflare is documented as the default because the
free tiers are generous and both halves live in one dashboard.

## Storage

| Provider | Endpoint | Region | Path style | Conditional writes |
|---|---|---|---|---|
| **Cloudflare R2** | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | on | yes |
| **AWS S3** | `https://s3.<region>.amazonaws.com` | the real region | either | yes |
| **Backblaze B2** | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | on | check current docs |
| **MinIO** (self-hosted) | your server URL | `us-east-1` | on | recent versions |
| **Wasabi** | `https://s3.<region>.wasabisys.com` | the real region | on | check current docs |

Use **Test connection** in the plugin before going further. It performs a real
PUT, GET, compare and DELETE, so a pass means the credentials genuinely have
everything publishing needs — not just that the host resolved.

If a provider does not support conditional writes, the plugin detects it at
runtime and degrades to a read-then-warn check. Publishing still works; the
protection against two devices publishing at the same moment is weaker. Run
**Storage self-test** in settings to see which behaviour you have.

## Hosting

The starter's build command is:

```
node scripts/fetch-content.mjs && node scripts/build-site.mjs && node scripts/finalize.mjs
```

Output directory: `public`. Environment variables: `OP_ENDPOINT`, `OP_BUCKET`,
`OP_REGION`, `OP_ACCESS_KEY_ID`, `OP_SECRET_ACCESS_KEY`, plus `OP_PREFIX` if you
use one.

### Cloudflare Workers Builds

The forward-looking Cloudflare option, since Pages is in maintenance mode.
Same repository, same build command, same variables. Deploy hooks work the same
way.

### Netlify

Build command `npm run build`, publish directory `public`. Environment variables
under **Site configuration → Environment variables**. Deploy hook under
**Build & deploy → Build hooks**.

Netlify's plans are credit-based — roughly 300 credits with deploys at about 15
each, so around 20 deploys a month on the free tier. Set *Minimum minutes
between builds* higher than the Cloudflare default.

Netlify reads `_redirects` and `_headers` from the publish directory natively,
so both files work unchanged.

### Vercel

Framework preset **Other**, build command `npm run build`, output directory
`public`. Environment variables under **Settings → Environment Variables**.
Deploy hook under **Settings → Git → Deploy Hooks**.

Vercel does not read `_redirects` or `_headers`. Rename redirects and the
`no-store` rule on `/_publish.json` will not apply, which means the plugin may
briefly report a stale snapshot as live. Translate them into `vercel.json` if
you need them; the cache-busting nonce on each poll covers most of the risk.

### GitHub Pages

Workable but awkward: it has no deploy hook, so builds are triggered by a
`repository_dispatch` or `workflow_dispatch` webhook instead. Point the plugin's
deploy hook URL at the GitHub API endpoint with a token — but note that a GitHub
token is a much wider credential than a deploy hook URL, which is a poor trade
for the design described in [security.md](security.md).

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
