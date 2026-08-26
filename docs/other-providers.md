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

Netlify's plans are credit-based: roughly 300 credits with deploys at about 15
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
deploy hook URL at the GitHub API endpoint with a token, but note that a GitHub
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
