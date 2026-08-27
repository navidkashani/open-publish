# Architecture

## The problem with the obvious design

The obvious way to build this is: upload the files that changed, then write a
`manifest.json` listing them.

That is not atomic. The manifest points at mutable paths, so any build that
starts mid-upload (a retry, a second device, someone clicking "Retry
deployment" in a dashboard) reads a half-updated tree and deploys it.

Obsidian Publish itself does not have this problem, because it has no build
step: it is a client-side app that fetches Markdown on demand, so a half-updated
set of files is merely temporarily inconsistent. **We have a build, so we need
atomicity they never needed.** That single difference shapes everything below.

## Content-addressed snapshots

```
objects/<ab>/<sha256>        immutable, content-addressed, deduplicated
snapshots/<id>.json          immutable manifest: path → hash, slug, links
current.json                 the only mutable key
```

A publish uploads missing objects, writes a snapshot, then commits by replacing
`current.json`. Consequences, all of which come free:

| Situation | What happens |
|---|---|
| Upload interrupted | Orphan objects, never a broken site |
| Publish retried | Same hash, same key: idempotent |
| File deleted | Absent from the next snapshot. No delete API call anywhere |
| Two devices publish at once | Compare-and-swap rejects the loser; no corruption |
| Rollback | Rewrite one ~60-byte file. Mechanically trivial, but there is no UI for it yet (roadmap phase 3) |
| Resume after a crash | `HEAD` each object, skip what exists |
| Garbage collection | Separate, optional, never on the publish path |

The commit uses `If-Match` on the ETag read at scan time. R2 and S3 both support
conditional writes through the S3 API. Providers that do not are detected at
runtime and degrade to a read-then-warn check: a lost update becomes possible
there, corruption does not.

## Snapshot format

```jsonc
{
  "version": 1,
  "id": "2026-08-24T11-04-02Z-a3f9c1",   // sortable timestamp + content digest
  "parent": "2026-08-23T18-22-40Z-77b2e0",
  "createdAt": 1756032242000,
  "generator": { "plugin": "open-publish", "version": "0.1.0" },
  "site": { "title": "My Notes", "showGraph": true },
  "files": {
    "Notes/Zettelkasten.md": {
      "hash": "…", "size": 4211, "mtime": 1755900000000,
      "slug": "notes/zettelkasten", "title": "Zettelkasten", "aliases": ["Zettel"]
    }
  },
  "links": {
    "Notes/Zettelkasten.md": [
      { "raw": "Luhmann",     "target": "Notes/Luhmann.md",      "status": "published", "slug": "notes/luhmann" },
      { "raw": "Private Log", "target": "Journal/Private Log.md", "status": "unpublished" },
      { "raw": "Nothing",     "target": null,                     "status": "unresolved" }
    ]
  },
  "redirects": [{ "from": "notes/old-name", "to": "notes/zettelkasten" }]
}
```

The ID is derived from the file set **and** the `site` block, so flipping a
single site toggle produces a new snapshot and therefore a rebuild, even with no
file changes. Republishing identical content within the same second yields the
same ID: retries are idempotent by construction.

## Key decisions

### Site options are intent, not generator settings

The plugin's site options describe *what the user wants*, never how a particular
generator does it. Each starter maps them onto its own mechanisms, which is what
lets a second starter exist without the plugin knowing anything about it.

An option earns a place only if it changes what content is visible, who can see
it, or how the site looks, **and** if any reasonable static site generator
could honour it. That second clause is load-bearing: it is why there is no
capability-negotiation protocol between plugin and starter. There is nothing to
negotiate when every option is universal.

Currently twelve: `title`, `homepage`, `noIndex`, `showThemeToggle`,
`strictLineBreaks`, `showNavigation`, `showSearch`, `showGraph`, `showOutline`,
`showBacklinks`, `showTags`, `analytics`.

Deliberately excluded, so the decisions do not get relitigated:

| Excluded | Why |
|---|---|
| Forced light/dark default | Needs patching generator internals (Quartz reads `prefers-color-scheme` in an inline script) |
| Site description | Generators derive per-page descriptions from content |
| Readable line length | Quartz's page width is a compile-time SCSS variable, not config |
| Logo, navigation ordering | Generator-specific plumbing; nav ordering needs functions, not JSON |
| Stacked pages | No equivalent outside Obsidian Publish |
| Passwords | Needs server-side auth, and would invalidate the "read-only build token is harmless" position in security.md |
| Collaborators, custom domain | SaaS or host-level concerns, not properties of a snapshot |

`homepage` is resolved in the **plugin**, not the starter: the chosen note gets
the slug `index`, so links to it and redirects from its old name resolve to `/`
for free and no generator needs to know the concept exists.

Two rules keep the contract safe as it grows:

- **The starter merges the snapshot over its own defaults**, never replaces
  them. A snapshot from an older plugin will not carry keys added since, and
  `undefined` is falsy: replacing wholesale would silently switch off search
  and navigation on a live site.
- **Unknown options are dropped and logged.** A starter that predates an option
  ignores it and says so, rather than guessing.

### The starter is a Quartz fork, not a thin wrapper

The template repository contains Quartz's source rather than cloning it at build
time. The thin version looked tidier and made version bumps a one-line change,
but it was worse for the person actually using it:

- Every Quartz tutorial says "edit `quartz/styles/custom.scss`" or
  "`quartz/components/...`". Those paths did not exist in a thin repo, so a user
  following the documentation hit a wall with nothing to search for.
- Every build cloned Quartz and resolved 555 packages, so every publish depended
  on github.com and the npm registry being up, and nothing could be cached
  against the root lockfile.
- Quartz needs Node 22+; its `.node-version` only travels with a fork.

The version-bump convenience turned out to favour the maintainer, not the user:
"Use this template" copies a repository, so existing users never receive template
updates anyway.

`starters/quartz/` in this repo holds only the overlay: the files we author.
`assemble.mjs` combines it with Quartz at a pinned tag, preserving Quartz's
history and setting an `upstream` remote so upgrades are a normal `git merge`.

#### Keeping the two repositories in step

The overlay lives here; the assembled template lives at
[navidkashani/open-publish-quartz](https://github.com/navidkashani/open-publish-quartz).
That split is the one structural weakness in this design, and it has already
been paid for once: the template ran six commits and one broken build behind the
overlay, and nothing anywhere said so. Setup step 3 sends every new user
straight at it, so a stale template is a broken product, not untidiness.

**Whenever anything under `starters/quartz/` changes, re-assemble and push:**

```bash
node starters/quartz/assemble.mjs /tmp/op-quartz --ref v4.5.1 \
  --push git@github.com:navidkashani/open-publish-quartz.git
```

The push is a force, by design: the template is regenerated from this overlay
rather than edited, so its tip commit is replaced. That is safe for users, whose
repositories are template copies with their own history and whose `upstream`
points at Quartz. It is not safe for a commit made on the template and never
brought back here, so the script prints the tip it is about to overwrite.

Two checks stand behind that, because remembering is not a mechanism:

- `assemble.test.mjs` requires every file in the overlay to be declared either
  shipped or deliberately withheld. `wrangler.jsonc` was neither, so it was
  never copied, and the template lacked the Workers Builds config that the
  overlay's own tests were asserting about.
- The `template` job in CI re-checks the published template against the overlay
  on any push touching this path, and fails when they differ.

### Ship a resolved link index

Raw Markdown alone is not enough. Obsidian resolves `[[Note]]` against the whole
vault: shortest-path matching, aliases, attachment folders. Publish a subset and
a generator cannot reproduce that, so links break.

The plugin already has `metadataCache.resolvedLinks` and
`getFirstLinkpathDest()`, so it emits the resolution alongside the notes. Notes
stay byte-identical; the intelligence travels beside them. Targets that resolve
but were not published are marked `unpublished`, and the generator renders them
as plain text rather than a link to a page that does not exist.

This is a real advantage over Quartz and the Digital Garden plugin, both of
which re-derive link resolution imperfectly.

### `requestUrl`, never `fetch`

Obsidian's `requestUrl` bypasses CORS entirely, so **users never configure a
bucket CORS policy**: one whole onboarding step and a large class of support
tickets deleted. It accepts `ArrayBuffer` bodies and works on mobile.

The cost: no streaming and no multipart, so the whole file sits in memory. Hence
the size limits: warn above 25 MB, refuse above 100 MB.

### A minimal S3 client, not the AWS SDK

"S3-compatible" is not uniform: path-style versus virtual-host addressing,
`region: auto` on R2, ListObjectsV2 differences, and the CRC32 checksum headers
recent AWS SDK v3 versions send by default, which several providers reject.

Four verbs is all this needs, so `destinations/sigv4.ts` signs them itself using
Web Crypto: about 120 lines and no dependency. It is verified against AWS's own
published reference signature, and cross-checked against the starter's separate
Node implementation so the two cannot drift.

### Build status by polling the site, not the hook

Deploy hooks return a job ID at best, and no provider gives neutral build status
without more credentials. So the starter writes `/_publish.json` containing the
snapshot ID it built, and the plugin polls the live URL until the ID matches.
Provider-neutral, no extra credentials, works everywhere.

The starter also ships a `_headers` rule setting `Cache-Control: no-store` on
that path, and the plugin adds a cache-busting nonce to every poll. A CDN
serving a cached marker would report a stale snapshot as live, the wrong
direction to be wrong in.

### Auto-include embedded attachments

The most common real-world failure in every subset-publishing tool: a user
publishes `Notes/`, their images live in a vault-level `attachments/` folder
outside the include rules, and the site ships with broken images. Obsidian
Publish handles this with a manual "Add linked" button, which people forget to
press.

Open Publish follows `![[…]]` embeds transitively and pulls those files in
automatically, regardless of folder rules. An explicit `publish: false` still
wins. That is a user decision, and a convenience feature must not override it.

Linked-but-not-embedded notes stay manual, behind an "Add linked" button. That
is a content decision, not a correctness bug.

### Renames become redirects

A renamed note changes its URL and breaks every external link to it. Renames are
detectable for free: diff the previous snapshot against the new one, and a path
that disappears while a new path appears with the same content hash is a rename.

Redirects carry forward across publishes and chains collapse: rename a note
twice and the original URL still reaches it in one hop.

### Content-addressed keys make filename weirdness a non-issue

Emoji, spaces, Cyrillic, combining characters, macOS-versus-Windows Unicode
normalisation: the classic S3-key and URL-encoding bugs all disappear, because
object keys are hex hashes. The only place a real path appears is inside the
snapshot JSON, where it is just a string.

Slugs still need care, which is what `core/slug.ts` and the collision check are
for: `Note.md` and `note.md` coexist happily on macOS and Windows and collide
silently on the Linux build machine, so that is blocked at scan time.

## Publishing state machine

```
IDLE
 → SCANNING     read current.json + snapshot   ← the remote is always the source of truth
                walk the vault, resolve flags, pull in embeds, hash,
                build the link index, detect renames, check slugs and sizes
 → REVIEW       the user ticks files            [the only interactive state]
 → PREFLIGHT    HEAD objects, skip what is already stored
 → UPLOADING    PUT missing objects, 4 at a time, 3 retries with backoff
 → COMMITTING   PUT the snapshot, then current.json with If-Match  ← the atomic commit
 → TRIGGERING   POST the deploy hook  (skipped if nothing changed, throttled, or turned off)
 → VERIFYING    poll /_publish.json?t=… until the ID matches, 10 minute timeout
 → DONE
```

Rules that fall out of this:

- **Single-flight.** One publish per vault; a second click joins the running one
  rather than starting a second.
- **No changes means no build.** Free-tier build allowances are scarce.
- Anything failing **before** `COMMITTING` leaves the site untouched. Uploaded
  objects are harmless orphans and are reused next time.
- `COMMITTING` failing on `If-Match` means someone else published. Re-scan and
  retry; never force.
- `TRIGGERING` or `VERIFYING` failing means the content is committed and only
  the build did not run. That is a *notification* problem, not a data problem,
  and the interface says so, because the user's instinct is to republish, and
  republishing is not what fixes it.

## Platform limits that shaped the design

Verified against Cloudflare's documentation. Cloudflare Pages happens to hold
the tightest value in every row, which is why these are applied on every host as
a floor rather than per host: a limit that varies by host would be one more
thing to get wrong, for a ceiling nobody would notice being raised.

The copy is a separate matter. It lives in `core/limits.ts` beside the numbers
and names no vendor, because two of these *block a publish*, and blocking a
Netlify user with a sentence about Cloudflare Pages is the storage catalogue's
R2-hint bug again with higher stakes.

| Limit | Value | What it forces |
|---|---|---|
| Assets per deployment | 20,000 free | Warn at 15,000, block at 19,000 |
| **Max asset size** | **25 MiB** | A 30 MB video cannot be served at all. Blocked at scan time with an explanation |
| Build timeout | 20 minutes | Warn when a snapshot exceeds ~500 MB |
| Builds per month (free) | 500, 1 concurrent | Throttling is mandatory, not optional |
| `_redirects` | 2,000 rules | Rename redirects are capped, keeping the most recent |
| R2 conditional writes | `If-Match` supported | Gives a real compare-and-swap on `current.json` |

Two limits deliberately have no code behind them. Netlify's free plan is about
20 deploys a month, and Vercel's is 100 a day; neither is enforced, because a
minimum wait between builds cannot protect a monthly allowance (five minutes
still permits about 8,600 a month) and silently raising somebody's throttle from
an inference would change a setting that governs their bill. Both are stated
instead, next to the two controls that spend them.

## Testing

Every core module avoids importing Obsidian values, so the real implementation
(not a copy) runs under plain Node. `npm test` covers:

- the signer, against AWS's published reference vector
- selection precedence, slug generation, collision detection
- snapshot IDs, diffing, rename and redirect-chain detection
- publisher atomicity: write ordering, interruption, resume, deduplication,
  compare-and-swap conflicts, single-flight, retry policy
- garbage collection safety
- the link rewriter, including code fences and frontmatter
- the full build pipeline, run as real subprocesses against a real HTTP server
  standing in for a bucket

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Walking skeleton, atomic round trip | done |
| 1 | Scanner, hasher, selection, snapshots, S3 destination, webhook builder, publish UI | done |
| 2 | Setup wizard, link index, redirects, "Add linked", throttling, error mapping, guards, GC, docs | done |
| 3 | Worker gateway and Deploy-to-Cloudflare button; mobile testing (including the rule rows' long-press); rollback UI; site options parity | in progress |
| 4 | Astro starter; optional Git destination | started early |

The gateway is done: `gateway/` is a Worker that holds the R2 binding, so the
plugin carries a bearer token rather than a key pair. What is left in phase 3 is
the Deploy-to-Cloudflare button, still gated on whether Cloudflare's setup page
can bind a bucket that already exists, plus the rollback UI and a real device
pass. Phase 4 has begun out of order too: `jotter`, the Astro starter, is in
progress in its own repository.

Both halves of the provider work landed early, out of phase 4: storage presets
first, then hosting. The starter also ships a `wrangler.jsonc`, so Cloudflare
Workers Builds is a supported target rather than a documented possibility.
Pages keeps the recommendation, for one reason: Workers Builds reports no site
address, so `OP_SITE_URL` has to be set by hand there.

Hosting presets (Cloudflare Pages, Cloudflare Workers, Netlify, Vercel and a
free-form "Another host") work the same way, in `builders/hosts.ts`. The one
difference is that there is nothing to compose: a deploy hook URL is opaque and
can only be pasted, so the host id is *inferred* from it by exact match and
never stored as a second source of truth. `WebhookBuilder` receives the same
`WebhookConfig` it always has.

What that id is allowed to decide is worth stating, because it is less than it
looks. It picks copy, instructions, one line of the environment block, and which
free plan is quoted next to the two controls that spend it. It changes no stored
value, no limit, and nothing that is sent. `minIntervalMinutes` and
`autoTrigger` in particular are never written from an inference: they govern
somebody's monthly build allowance, and a guess is no basis for changing a
number that decides a bill.

Destination presets (R2, S3, B2, Wasabi, MinIO, and a free-form "Other") landed
early, out of phase 4. They are presentation and prefill only:
`destinations/providers.ts` is a table with no imports, and nothing in it
reaches the wire. `S3Destination` receives the same `S3Config` it always has,
and the endpoint string remains the only source of truth for what is signed and
sent, so a provider id that is missing, stale or wrong costs a label and
nothing else.

One entry in that table breaks the rule, deliberately and in exactly one place.
"Cloudflare R2 without keys" carries `kind: 'gateway'`, which decides the `type`
discriminant on the stored destination, and `main.ts` builds a
`GatewayDestination` from it instead of an `S3Destination`. That is the whole of
the seam: `destinations/types.ts` did not change, and the publisher, the
scanner, the collector and the self-test depend on `Destination` and nothing
narrower, so none of them can tell the difference. The gateway is a Worker the
user deploys to their own account (`gateway/` in this repository); the plugin
holds a bearer token for it rather than a storage key, which shrinks what a
leaked credential reaches without pretending anything is encrypted. See
[security.md](security.md).

## Open questions

1. **A Git destination.** Content in Git is forbidden by the current brief, and
   that constraint costs roughly five onboarding steps and a second credential
   pair. A `GitDestination` writing to an orphan `content` branch would need one
   account and one token, and would get atomicity, history and rollback for
   free. The `Destination` interface is deliberately shaped to accept this later:
   `list()` and `delete()` are used only by garbage collection, never on the
   publish path. Deferred, not discarded.
2. **`metadataCache.getFileInfo()` is undocumented.** It gives us a SHA-256 per
   file for free. Verified against Obsidian 1.13.7, guarded at runtime, and the
   `readBinary` + `crypto.subtle` fallback is a fully supported path. If the API
   disappears, publishing gets slower rather than broken.
3. **Bundled assets versus serving from the bucket.** Bundling is simple and
   provider-neutral, and is the v1 default. Serving assets straight from a
   public bucket URL would make builds faster but needs a public bucket or a
   custom domain.
