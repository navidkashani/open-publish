# Architecture

This is the contributor-facing file. It records why the design is shaped the way
it is, so the same questions do not get reopened.

## The problem with the obvious design

The obvious way to build this is to upload the files that changed, then write a
`manifest.json` listing them.

That is not atomic. The manifest points at mutable paths, so any build that
starts mid-upload reads a half-updated tree and deploys it. A retry, a second
device, or someone clicking "Retry deployment" in a dashboard all do it.

Obsidian Publish does not have this problem, because it has no build step. It is
a client-side app that fetches Markdown on demand, so a half-updated set of files
is only temporarily inconsistent. **We have a build, so we need atomicity they
never needed.** That single difference shapes everything below.

## Content-addressed snapshots

Each file is stored under a name made from its own contents.

```
objects/<ab>/<sha256>        immutable, deduplicated, never overwritten
snapshots/<id>.json          immutable manifest: path → hash, slug, links
current.json                 the only mutable key
```

A publish uploads missing objects, writes a snapshot, then commits by replacing
`current.json`. The consequences all come free:

| Situation | What happens |
|---|---|
| Upload interrupted | Orphan objects, never a broken site |
| Publish retried | Same content, same hash, same key. Publishing twice does the same as publishing once |
| File deleted | Absent from the next snapshot. No delete API call anywhere |
| Two devices publish at once | The commit only succeeds if nobody else changed the pointer first, so the loser is rejected rather than merged |
| Rollback | Rewrite one ~60-byte file. Site history in settings lists what is in the bucket and makes any of it live |
| Resume after a crash | The pointer never moved, so anything already uploaded is skipped |
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
      "hash": "…", "size": 4211,
      "mtime": 1755900000000, "ctime": 1750000000000,   // best effort; see below
      "slug": "notes/zettelkasten", "title": "Zettelkasten", "aliases": ["Zettel"],
      "legacyUrls": ["Notes/Zettelkasten"]   // only when the vault is migrating
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

The ID comes from the file set **and** the `site` block, so flipping one site
toggle produces a new snapshot and therefore a rebuild. Republishing identical
content within the same second yields the same ID, which is what makes retries
free. Neither timestamp is part of it, so touching a file costs no build.

### The two timestamps are best effort, and `created:` outranks them

`mtime` and `ctime` come from Obsidian's `FileStats`, which comes from the
filesystem, and the filesystem loses them. Sync, a restore from backup and an
ordinary file transfer all reset the creation date to the moment the copy landed.
So the precedence a starter should implement is:

1. **the note's own `created:` / `updated:` frontmatter**, the only source the
   author controls;
2. then the snapshot's `ctime` / `mtime`;
3. and `mtime` again wherever `ctime` is later than it, which is corruption
   rather than a note edited before it existed.

They are worth carrying, because the alternative is not a better date. A vault
fetched from a snapshot is written fresh with no git history, so a generator's
own fallbacks all collapse to the moment of the build.

## Key decisions

### Site options are intent, not generator settings

The plugin's site options describe *what the user wants*, never how a particular
generator does it. Each starter maps them onto its own mechanisms, which is what
lets a second starter exist without the plugin knowing anything about it. An
option earns a place only if it changes what content is visible, who can see it,
or how the site looks, **and** if any reasonable static site generator could
honour it. That second clause is why there is no capability negotiation between
plugin and starter: there is nothing to negotiate when every option is universal.

Currently eighteen: `title`, `homepage`, `locale`, `dir`, `noIndex`,
`showThemeToggle`, `strictLineBreaks`, `showNavigation`, `showSearch`,
`showGraph`, `showOutline`, `showBacklinks`, `showTags`, `showPageMetadata`,
`showPrevNext`, `nav`, `folders`, `analytics`.

**A generator that cannot express an option ignores it.** It must never guess,
and it must never report the option as unknown, which would tell the user their
plugin is too new when the truth is that their generator has no such control.
`showPrevNext` is the live example: Quartz ships no previous/next component, so
the Quartz starter carries the intent and renders nothing for it.

Deliberately excluded, so the decisions do not get relitigated:

| Excluded | Why |
|---|---|
| Forced light/dark default | Needs patching generator internals |
| Site description | Generators derive per-page descriptions from content |
| Readable line length | Quartz's page width is a compile-time SCSS variable |
| Logo | Generator-specific plumbing |
| Stacked pages | No equivalent outside Obsidian Publish |
| Passwords | Needs server-side auth, and would invalidate the "read-only build token is harmless" position in security.md |
| Collaborators, custom domain | Host-level concerns, not properties of a snapshot |

`homepage` is resolved in the **plugin**, not the starter. The chosen note gets
the slug `index`, so links to it and redirects from its old name resolve to `/`
for free.

`dir` is the one option that is not a statement of fact about the vault. It is a
presentation directive derived from `locale` and rewritten on every load, with no
control of its own. It is admissible only because the Quartz starter was taught
to honour it, in `scripts/lib/rtl-patch.mjs`. The escape clause above has a
matching limit: ignoring `showGraph` gives you no graph, and ignoring `dir` gives
you a site laid out backwards for its reader.

### Navigation ordering

`nav` is a JSON array in the snapshot. The starter derives whatever its own
explorer needs from it. For Quartz that is a comparator function, built in
`starters/quartz/nav-sort.ts`.

Three things about the shape are load-bearing rather than tidy.

**The order is materialised per parent, and only for parents somebody actually
arranged.** Quartz inlines the explorer's options into every page's HTML, so a
full order of five thousand slugs would be about 150KB per page. Arranging one
folder of twenty ships twenty entries, and a vault that never opens the manager
carries no `nav` key at all.

What decides whether a parent is carried is whether somebody **addressed** it,
not whether the result differs from the default. Dropping a parent whose order
matches the default looks like a free optimisation and is not: the default
belongs to the *generator*, and the two starters disagree about it. Quartz puts
folders first everywhere; jotter puts the root's loose notes above its folders.
An arrangement measured against Quartz's default and dropped on a match would
reach jotter as no instruction, and jotter would render the opposite of what the
manager showed. Hiding is excluded from "addressed" for the mirror reason: it
travels in its own list and leaves the rest of the order alone.

**Slug space, keyed `<folder-slug>/index` for folders**, matching Quartz's
`FileTrieNode.slug` getter. The plugin's own copy in `data.json` holds vault
paths instead, because a slug moves when a note is renamed and a stored order
that quietly emptied itself would be worse than none. `core/navorder.ts` is the
only thing that speaks both, and it converts once, in the scan.

**The homepage is a row, and the two starters disagree about that.** The manager
lists it among the root's notes, keyed by the slug it is served at, `index`.
Quartz has no such row, so an entry naming it sits inert. jotter draws `/` in its
sidebar, and there the entry lands. Both are right: the plugin states what the
site shows, and a generator with no such row ignores the line.

`folders` is the least like the rest: not intent, but a fact the generator cannot
reach. Every other name on a site travels inside a file. A folder has no file, so
a generator rebuilding the tree from slugs can only call it by its address, and
the sidebar reads `wisdom-approaches` where the vault reads "Wisdom & Approaches".
The plugin sends the difference, carrying only the folders whose name is not
already their slug segment, so the sidebar reads back what Customize navigation
showed. jotter keeps its old guesswork as a fallback for older snapshots. Quartz
applies the names through the explorer's `mapFn`, which runs before the sort, so
a renamed folder also sorts under the name a reader sees.

If somebody genuinely needs thousands of pages ordered, the escape hatch is to
patch `contentIndex.tsx` to carry a per-note rank into `ContentDetails`, which is
fetched once rather than inlined per page, and have the comparator read `a.data`.

`nav` also makes `showPrevNext` answerable. "Next" means the order the navigation
already uses, and this is that order, expressed as data.

Two rules keep the contract safe as it grows:

- **The starter merges the snapshot over its own defaults**, never replaces them.
  An older snapshot will not carry keys added since, and `undefined` is falsy, so
  replacing wholesale would silently switch off search and navigation on a live
  site.
- **Unknown options are dropped and logged.**

### Two starters, and the one thing the plugin has to know about them

The setup guide offers a choice on step 3: `jotter`, an Astro theme in its own
repository and the one recommended, or `open-publish-quartz`, the reference
starter this repository builds and verifies on every commit. Both consume the
same snapshot and publish the same bytes.

The evidence behind the two is not the same, and anyone weighing them should be
able to find out where the line falls. **This repository can vouch for the half
of every contract that lives here:** `snapshot.test.mjs` asserts the rules the
plugin emits, and `starters/quartz/scripts/pipeline.test.mjs` asserts one starter
consuming them. jotter passes its own suite in its own repository, including a
`--full` pass that fetches a snapshot from a stand-in bucket, builds the site and
asserts the addresses it serves. Good evidence, and not the same evidence.

`builders/starters.ts` is the third catalogue after storage providers and hosts,
and it lives by the same "none of it reaches the wire" rule, with one exception.
**Where the build leaves the finished site differs**: Quartz writes `public`,
Astro writes `dist`. A host told the wrong directory deploys an empty one and
reports success, so `hosts.ts` takes the chosen starter's build rather than
naming a directory, and each host composes it into its own vocabulary: "Output
directory" on Cloudflare and Vercel, "Publish directory" on Netlify. The same
table carries `hasWranglerConfig`, because Workers Builds is connect-and-go only
for a starter that ships one; both do now, and the field stays because the answer
belongs to the starter rather than to `hosts.ts`.

The environment variables are deliberately *not* per-starter, and a test asserts
it: both read the same eight, so the block step 4 hands over is identical either
way. `builder.starter` needed no `SETTINGS_VERSION` bump, because an older build
merges the builder with `Object.assign`, so a key it has never heard of passes
straight through a downgrade and back.

### The starter is a Quartz fork, not a thin wrapper

The template repository contains Quartz's source rather than cloning it at build
time. The thin version looked tidier, and was worse for the person using it:
every Quartz tutorial names paths like `quartz/styles/custom.scss` that a thin
repo does not have, every build depended on github.com and the npm registry being
up, and Quartz's `.node-version` only travels with a fork.

"Use this template" copies a repository, so a copy receives nothing by itself.
jotter closes that with `.github/workflows/update-theme.yml`, which merges on a
branch inside the user's own repository and opens a pull request. That works
because the unrelated-histories restriction applies to pull requests *between*
repositories, and a branch in one repository is not one.

Quartz cannot have the same thing. `assemble.mjs` regenerates that repository and
**force-pushes** it, so its tip is rewritten and any downstream merge is against
commits that no longer exist. That also rules out a fork with GitHub's native
sync button. It is the one real difference between the two starters.

`starters/quartz/` in this repo holds only the overlay: the files we author.
`assemble.mjs` combines it with Quartz at a pinned tag, preserving Quartz's
history and setting an `upstream` remote so upgrades are a normal `git merge`.

#### Keeping the two repositories in step

The overlay lives here; the assembled template lives at
[navidkashani/open-publish-quartz](https://github.com/navidkashani/open-publish-quartz).
That split is the one structural weakness in this design, and it has been paid
for once already: the template ran six commits and one broken build behind the
overlay, and nothing said so. Setup step 3 sends every new user straight at it.

**Whenever anything under `starters/quartz/` changes, re-assemble and push:**

```bash
node starters/quartz/assemble.mjs /tmp/op-quartz --ref v4.5.1 \
  --push https://github.com/navidkashani/open-publish-quartz.git
```

The push is a force, by design: the template is regenerated from this overlay
rather than edited. That is safe for users, whose repositories are template
copies with their own history. It is not safe for a commit made on the template
and never brought back here, so the script prints the tip it is about to
overwrite. Two checks stand behind that, because remembering is not a mechanism:
`assemble.test.mjs` requires every overlay file to be declared shipped or
deliberately withheld, and the `template` workflow re-checks the published
template against the overlay on any push touching this path.

### Ship a resolved link index

Raw Markdown alone is not enough. Obsidian resolves `[[Note]]` against the whole
vault: shortest-path matching, aliases, attachment folders. Publish a subset and
a generator cannot reproduce that, so links break.

The plugin already has `metadataCache.resolvedLinks` and
`getFirstLinkpathDest()`, so it emits the resolution alongside the notes. Notes
stay byte-identical. Targets that resolve but were not published are marked
`unpublished`, and the generator renders them as plain text rather than as a link
to a page that is not there.

### `requestUrl`, never `fetch`

Obsidian's `requestUrl` bypasses CORS entirely, so **users never configure a
bucket CORS policy**. That deletes one onboarding step and a large class of
support tickets. It accepts `ArrayBuffer` bodies and works on mobile. The cost is
no streaming and no multipart, so the whole file sits in memory. Hence the size
limits: warn above 25 MB, refuse above 100 MB.

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
snapshot ID it built, and the plugin polls the live URL until the ID matches. The
starter also ships a `_headers` rule setting `Cache-Control: no-store` on that
path, and the plugin adds a cache-busting nonce to every poll: a CDN serving a
cached marker would report a stale snapshot as live, which is the wrong direction
to be wrong in.

### Auto-include embedded attachments

The most common real-world failure in every subset-publishing tool: a user
publishes `Notes/`, their images live in a vault-level `attachments/` folder
outside the include rules, and the site ships with broken images.

Open Publish follows `![[…]]` embeds transitively and pulls those files in
automatically, whatever the folder rules say. An explicit `publish: false` still
wins, because that is a user decision. Linked-but-not-embedded notes stay manual,
behind an "Add linked" button, because that is a content decision rather than a
correctness bug.

### Renames become redirects

A renamed note changes its URL and breaks every external link to it. Renames are
detectable for free: diff the previous snapshot against the new one, and a path
that disappears while a new path appears with the same content hash is a rename.
Redirects carry forward across publishes, and chains collapse, so renaming a note
twice still leaves the original URL reaching it in one hop.

### Content-addressed keys make filename weirdness a non-issue

Emoji, spaces, Cyrillic, combining characters, macOS-versus-Windows Unicode
normalisation: the classic S3-key and URL-encoding bugs all disappear, because
object keys are hex hashes. The only place a real path appears is inside the
snapshot JSON, where it is just a string. Slugs still need care, which is what
`core/slug.ts` and the collision check are for: `Note.md` and `note.md` coexist
happily on macOS and Windows and collide silently on the Linux build machine.

### Old Obsidian Publish URLs

Obsidian Publish serves `Company/About us.md` at `/Company/About+us`: each path
segment form-urlencoded, case intact. Our slug for the same note is
`/company/about-us`, so somebody moving across on their own domain loses every
inbound link and every search ranking they had.

**Site URLs** in settings offers to keep them. When it is on, `core/slug.ts`
works out the old address of every file whose slug moved, and the scanner records
it as `legacyUrls` on that file. The value is the old URL *percent-decoded*,
because a static host decodes a request path before looking for a file.

The snapshot states where a file used to live, and what to do about it is the
generator's business, which is why this is not a `site` option. The Quartz
starter writes each one into the working copy's frontmatter as `permalink`, the
one key Quartz turns into a redirect page at exactly the path given, so this
covers notes and not attachments. `aliases` would not do: Quartz slugifies those,
turning `&` into `-and-`, which breaks the very URLs this is for. None of it
helps a vault that did not keep the domain Obsidian Publish served.

### Importing an Obsidian Publish configuration

The same migration, one step earlier. Obsidian Publish records a site's folder
filters in `<config dir>/publish.json`, and for a vault that uses no `publish:`
frontmatter that file is the *entire* definition of what is public. Retyping it
into "Manage folders..." is the one operation in this plugin where a single typo
publishes private notes. Measured on a real vault: 335 markdown files, 93 inside
the 8 configured folders, no note carrying `publish:` frontmatter, so a mistyped
rule exposes 242 private notes.

The file, read off a live vault:

```json
{
  "siteId": "e06fc8eb0e577dd6b3e0c6295c8602ad",
  "host": "publish-01.obsidian.md",
  "included": ["Wisdom & Approaches", "About", "Privacy", "WP Statistics",
               "Recommended", "Notes", "Team Productivity", "Personal Productivity"],
  "excluded": []
}
```

Literal folder paths, no globs and no wildcards. `matchesFolderRule` is prefix
based, so they import unchanged, and `getPublishFlag` resolves excludes before
includes exactly as Publish does, so an imported rule behaves the same on both
products. `included` becomes `selection.includes` and `excluded` becomes
`selection.excludes`, and that is the whole of it: **no field is added to
`Settings`**, no `SETTINGS_VERSION` bump, and nothing to migrate back down.

**Includes are replaced; excludes are merged.** Publish's include list is the
user's answer to "what is public", so it replaces ours wholesale. That is the
only destructive half, and it is bounded and listed rule by rule in the preview.
Excludes are only ever added to, because replacing them with Publish's
usually-empty list would delete a guard somebody added by hand. A *union* of
includes was rejected for the mirror reason: the default in a feature whose
failure mode is "242 private notes go public" cannot be the one that publishes
more.

The preview counts its headline with `getPublishFlag` over the real frontmatter,
as `scanner.ts` does, and a line says so whenever that disagrees with the
per-rule counts from `summarizeRules`. This screen carries the single most
privacy-critical number in the plugin, so it can afford the walk.

The import also offers, pre-ticked, to turn on the legacy URLs described above,
but only when `urlStyle` is still at its default. The asymmetry decides the
default: wrongly on costs a handful of redirect pages nobody visits, and wrongly
off costs every inbound link and search ranking, permanently.

Everything else about a Publish site lives somewhere this plugin does not go.
Obsidian's help is explicit that "configuration settings are stored on Obsidian's
servers": site name, homepage, theme, navigation, analytics and every per-file
selection are not in the vault at all.

#### Notes Publish served one at a time

A site can publish a note that no folder filter covers, and `publish.json` says
nothing about those. On the vault this was measured against, the sitemap lists 96
URLs, the folder import reproduces 93 exactly, and the three it misses were all
selected individually in Publish. Those three leave behind a `permalink` in their
frontmatter, which Publish honours as a custom URL.

So the import offers every note carrying a permalink that the planned rules would
*not* publish, resolved through `getPublishFlag` so a note a folder already
covers is never offered and an explicit `publish: false` is never overturned. It
is an offer with the boxes empty, not an import, because a permalink is good
evidence and a poor rule, and wrongly on here publishes a private note. Ticking
one writes `selection.explicit[path] = true` and nothing else. An unticked
candidate is "no opinion", never a stored `false`, which would invent a refusal
nobody made and then outrank any folder rule they add later. The list is capped
at 25 rows.

The offer is shown even when the plan is empty, which is the case it matters most
in: a site that selected every note by hand has an empty `included` list. So
`commit` leaves both rule lists alone when `plan.empty`, because nothing to
import must never mean everything to remove.

#### The endpoints, and why they are not called

A live Publish site's own HTML names two addresses:

```
https://publish-01.obsidian.md/cache/<siteId>
https://publish-01.obsidian.md/options/<siteId>
```

Both answer an anonymous GET, and `siteId` sits in `publish.json` in the vault.
The first returns the complete published file list, which is exactly the per-note
selection the offer above has to infer. The second returns the site options.

So "those selections cannot be imported" is not true. **They are readable, and
this plugin declines to read them.** The promise is that nothing passes through
anyone else's server, and one request telling Obsidian which site is being
migrated is a poor trade for three checkboxes. The screen says the plugin does
not talk to Obsidian rather than that the choices are unreachable. This is
written down so the next person to open that HTML reads it as a decision, and so
it can be reconsidered on purpose.

Deliberately not imported:

| Not imported | Why |
|---|---|
| `siteId` | Addresses a site on servers this plugin cannot reach, and it is an account-scoped identifier in a file that syncs between devices |
| `host` | `publish-01.obsidian.md` is Obsidian's internal shard. In `builder.siteUrl` it would poll a domain the user does not own, report "still waiting" forever, and send a request to Obsidian after every publish |
| `core-plugins.json` | Records which panes the *author* has open, not what *visitors* get. Its defaults disagree in the dangerous direction, so a typical import would switch site features off |
| `appearance.json` | A theme for the *app*, not the site |
| `app.json` `rightToLeft` | `site.dir` is rewritten from `site.locale` on every load, so the write would not survive a restart |
| Site options at `/options/<siteId>` | Readable without authentication, and left alone for the reason above. A migrating user re-enters three fields by hand |
| `templates.json`, `daily-notes.json` | The genuine near-miss. An exclude the plugin invented appears in Manage folders as a rule nobody typed, holding notes back with no explanation |

Also rejected: auto-importing on load or first run, watching `publish.json` for
changes, a startup `Notice` announcing the find, and offering to edit or delete
`publish.json`. The plugin never writes to the vault, and least of all there.

## Publishing state machine

```
IDLE
 → SCANNING     read current.json + snapshot   ← the remote is always the source of truth
                walk the vault, resolve flags, pull in embeds, hash,
                build the link index, detect renames, check slugs and sizes
 → REVIEW       the user ticks files            [the only interactive state]
 → PREFLIGHT    skip every hash the live snapshot already names; HEAD the rest, 8 at a time
 → UPLOADING    PUT missing objects, 4 at a time, 3 retries with backoff
 → COMMITTING   PUT the snapshot, then current.json with If-Match  ← the atomic commit
 → TRIGGERING   POST the deploy hook  (skipped if nothing changed, throttled, or turned off)
 → VERIFYING    poll /_publish.json?t=… until the ID matches, 10 minute timeout
 → DONE
```

Rules that fall out of this:

- **Single-flight.** One publish per vault. A second click joins the running one.
- **No changes means no build.** That run still confirms the objects the live
  snapshot names are really there, because the build refuses to run when one is
  missing, and without the check publishing again would take this exit and do
  nothing for ever. If something *is* missing, the bytes go back up and a rebuild
  is asked for, with no new snapshot and no pointer write.
- **Preflight costs one request per *changed* file, not per published file.**
  Every hash in the live snapshot was in storage when that snapshot was
  committed, and nothing on this path deletes. Two things are never taken on
  trust: a file held at its published version whose bytes are gone from the
  vault, and every object at all when storage has moved.
- Anything failing **before** `COMMITTING` leaves the site untouched. Uploaded
  objects are harmless orphans and are reused next time.
- `COMMITTING` failing on `If-Match` means someone else published. Re-scan and
  retry; never force.
- `TRIGGERING` or `VERIFYING` failing means the content is committed and only the
  build did not run. The interface says so, because the user's instinct is to
  republish, and republishing is not what fixes it.

## Platform limits that shaped the design

Verified against Cloudflare's documentation. Cloudflare Pages holds the tightest
value in every row, so these apply on every host as a floor: a limit that varied
by host would be one more thing to get wrong. The copy lives in `core/limits.ts`
beside the numbers and names no vendor, because two of these *block a publish*,
and blocking a Netlify user with a sentence about Cloudflare Pages would be the
wrong error.

| Limit | Value | What it forces |
|---|---|---|
| Assets per deployment | 20,000 free | Warn at 15,000, block at 19,000 |
| **Max asset size** | **25 MiB** | A 30 MB video cannot be served at all. Blocked at scan time |
| Build timeout | 20 minutes | Warn when a snapshot exceeds ~500 MB |
| Builds per month (free) | 500, 1 concurrent | Throttling is mandatory, not optional |
| `_redirects` | 2,000 rules | Rename redirects are capped, keeping the most recent |
| R2 conditional writes | `If-Match` supported | Gives a real guard on `current.json` |

Two limits deliberately have no code behind them. Netlify's free plan is about 20
deploys a month, and Vercel's is 100 a day. Neither is enforced, because a
minimum wait between builds cannot protect a monthly allowance, since five
minutes still permits about 8,600 builds a month, and raising somebody's throttle
from an inference would change a setting that governs their bill. Both are stated
next to the two controls that spend them.

## Testing

Every core module avoids importing Obsidian values, so the real implementation
runs under plain Node. `npm test` covers:

- the signer, against AWS's published reference vector
- selection precedence, slug generation, collision detection
- snapshot IDs, diffing, rename and redirect-chain detection
- publisher atomicity: write ordering, interruption, resume, deduplication,
  commit conflicts, single-flight, retry policy
- garbage collection safety
- the link rewriter, including code fences and frontmatter
- navigation ordering: precedence, per-parent scoping, and the minimality check
- the full build pipeline, run as real subprocesses against a real HTTP server
  standing in for a bucket

One test in `starters/quartz/scripts/nav-sort.test.mjs` guards something
invisible everywhere else. It round-trips the explorer's comparator through
`new Function("return " + fn.toString())()`, which is exactly what the browser
does with the serialised attribute. A comparator that closed over anything passes
every direct call and dies on that transform, silently. `npm run verify` repeats
it against the attribute a real Quartz build emits.

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 0 | Walking skeleton, atomic round trip | done |
| 1 | Scanner, hasher, selection, snapshots, S3 destination, webhook builder, publish UI | done |
| 2 | Setup wizard, link index, redirects, "Add linked", throttling, error mapping, guards, GC, docs | done |
| 3 | Worker gateway and Deploy-to-Cloudflare button; mobile testing; rollback UI; site options parity | in progress |
| 4 | Astro starter; optional Git destination | starter done, rest started early |

What is left in phase 3 is the Deploy-to-Cloudflare button, still gated on
whether Cloudflare's setup page can bind a bucket that already exists, plus a
real device pass.

The three catalogues, storage providers, hosts and starters, landed early, out
of phase 4. They are presentation and prefill only, and nothing in them reaches
the wire. `destinations/providers.ts` is a table with no imports, `S3Destination`
receives the same `S3Config` it always has, and the endpoint string remains the
only source of truth for what is signed and sent. A host id is *inferred* from
the pasted deploy hook URL by exact match and never stored, and it decides copy
and instructions only. `minIntervalMinutes` and `autoTrigger` are never written
from an inference, because they govern somebody's monthly build allowance.

One entry breaks that rule, deliberately and in exactly one place. "Cloudflare R2
without keys" carries `kind: 'gateway'`, which decides the `type` discriminant on
the stored destination, and `main.ts` builds a `GatewayDestination` from it
instead of an `S3Destination`. That is the whole of the seam:
`destinations/types.ts` did not change, and the publisher, scanner, collector and
self-test depend on `Destination` and nothing narrower.

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
