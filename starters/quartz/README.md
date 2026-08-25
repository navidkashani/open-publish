# Open Publish — Quartz starter

The site half of Open Publish. This repository builds a website from a snapshot
published to your object storage by the Obsidian plugin.

**Your notes are never committed here.** They are fetched at build time and live
only in the build machine's working directory.

## Use it

1. **Use this template → Create a new repository.** Do not clone; there is
   nothing to run locally.
2. Connect it to Cloudflare Pages (or Netlify, or Vercel).
3. Build command: `npm run build`. Output directory: `public`.
4. Add these environment variables, using a **read-only** storage token:

   | Variable | Value |
   |---|---|
   | `OP_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `OP_BUCKET` | your bucket |
   | `OP_REGION` | `auto` for R2 |
   | `OP_ACCESS_KEY_ID` | read-only key ID |
   | `OP_SECRET_ACCESS_KEY` | read-only secret (mark encrypted) |
   | `OP_PREFIX` | optional, if the plugin uses a key prefix |

Full walkthrough: [docs/setup-cloudflare.md](../../docs/setup-cloudflare.md).

## What the build does

```
npm run build
├── scripts/fetch-content.mjs   snapshot → content/
├── scripts/build-site.mjs      Quartz → public/
└── scripts/finalize.mjs        marker, headers, redirects
```

**`fetch-content.mjs`**

1. Reads `current.json`, then `snapshots/<id>.json`.
2. Downloads each object, **verifies its SHA-256**, and fails the build on a
   mismatch. Corrupt content must never reach the live site.
3. Writes files at their site slug, so URLs and paths agree.
4. Rewrites links using the snapshot's resolved index: published targets become
   real links, unpublished and unresolved ones become plain text.
5. Writes `op-site.ts` from the snapshot's site options.
6. Generates an index page if no published note claims the site root.

**`build-site.mjs`** runs Quartz. The published template *is* a Quartz fork, so
it builds the `quartz/` folder already in the repository. (The script also
supports cloning Quartz at a pinned ref, which is how the overlay is developed
before assembly.)

## Licence and attribution

This template contains [Quartz](https://github.com/jackyzha0/quartz) by
jackyzha0, used under the MIT licence; `LICENSE.txt` is Quartz's and stays as
it is. The Open Publish additions — `scripts/`, `op-site.ts` and the two config
files — are MIT as well.

## This repository is built on Quartz

That is deliberate, and it is what makes the following work:

- **Every Quartz guide applies to you directly.** `quartz/styles/custom.scss`
  and all 27 components are right here, so any Quartz tutorial, doc page or
  forum answer can be followed as written.
- **Builds are fast and self-contained.** Dependencies are cached by your host
  against the root lockfile, and no build depends on GitHub or the npm registry
  being reachable.
- **Node is pinned.** `.node-version` comes from Quartz, which needs Node 22+.

### Updating Quartz

You do not have to. A pinned version keeps working indefinitely, and most people
never touch this.

When you do want a newer Quartz, note that **"Use this template" starts your
repository at a single commit** — GitHub does not copy history into a
template-derived repo. So point it at Quartz yourself, once:

```bash
git remote add upstream https://github.com/jackyzha0/quartz.git
git fetch upstream
git merge upstream/v4 --allow-unrelated-histories
```

`--allow-unrelated-histories` is needed the first time precisely because the
template gave you a fresh history. Afterwards a plain `git merge upstream/v4`
works.

Conflicts land in `quartz.config.ts` and `quartz.layout.ts` — the files you are
meant to own. Keep your versions of those, plus `scripts/` and `op-site.ts`.

This is the one part of Open Publish that needs a terminal, and only if you opt
into it.

### Customising

- **Colours, fonts, plugins** — `quartz.config.ts`
- **Custom CSS** — `quartz/styles/custom.scss`
- **Layout and components** — `quartz.layout.ts`, and `quartz/components/`
- **Do not edit `op-site.ts`** — regenerated each build from your Obsidian settings

**`finalize.mjs`** runs *after* the generator, because generators clear their
output directory. It writes:

- `public/_publish.json` — the snapshot ID, which the plugin polls to know the
  deploy is live
- `public/_headers` — `Cache-Control: no-store` on that marker, so a CDN cannot
  make a stale snapshot look live
- `public/_redirects` — from renamed notes, capped at the 2,000-rule platform
  limit

It also fails the build loudly on an empty output directory, more than 19,000
files, or any asset over 25 MiB — all cases where the deploy would otherwise
succeed and the site would be quietly broken.

## Customising

- **Theme, fonts, colours, plugins** — `quartz.config.ts`, yours to edit.
- **Layout and components** — `quartz.layout.ts`, which reads the site toggles
  from `op-site.ts`.
- **Do not edit `op-site.ts`.** It is regenerated on every build from what you
  set in Obsidian.

## Tests

```bash
npm run test:starter   # unit tests for the fetch/rewrite/finalize scripts
npm run verify         # full pipeline against a fake bucket, then a real Quartz build
```

`test:starter` rather than `test` because `npm test` belongs to Quartz.

Covers the link rewriter, the signer (cross-checked against the plugin's, so the
two cannot drift), and the whole build pipeline run as real subprocesses against
a local HTTP server standing in for a bucket.
