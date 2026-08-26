# Open Publish

Publish part of your Obsidian vault as a website, using storage you own and a
host you choose. No subscription, no service in the middle.

```
Obsidian plugin  →  your object storage  →  deploy hook  →  your static host
```

Your notes go from Obsidian into your own bucket. Your host builds a site from
that bucket. Nothing passes through anyone else's server, and nothing is
published in Git.

## What it does

- **Publishes a subset of your vault.** Folder rules, or `publish: true` in
  frontmatter. Frontmatter always wins.
- **Never touches your notes.** The plugin only ever reads. Every piece of
  selection state lives in plugin settings, not in your files.
- **Never breaks the live site.** Publishing is atomic: the site switches to the
  new version in a single small write, or it does not switch at all.
- **Keeps links working.** Obsidian resolves `[[wikilinks]]` against your whole
  vault. The plugin ships that resolution alongside your notes, so a published
  subset links correctly, and a link to a note you did not publish renders as
  plain text instead of a dead end.
- **Brings your attachments along.** An image embedded by a published note is
  published too, wherever it lives in your vault.
- **Redirects renamed notes.** A rename changes a URL; old links keep working.
- **Site options that are not theme-specific.** Navigation, search, graph,
  backlinks, outline, tags, theme toggle, homepage, analytics and a
  discourage-search-engines switch, described as intent, so a future starter
  can honour them without the plugin knowing anything about it.

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | The Obsidian plugin. TypeScript, no runtime dependencies. |
| `starters/quartz/` | The site repository template: fetches a snapshot and builds it with Quartz. |
| `gateway/` | An optional Cloudflare Worker, so the plugin can reach R2 without holding a storage key. |
| `docs/` | Setup, architecture, security, troubleshooting. |

## Getting started

Follow **[docs/setup-cloudflare.md](docs/setup-cloudflare.md)**: about ten
minutes, no terminal, nothing to install outside Obsidian.

The setup guide opens on a storage picker. Cloudflare R2, Amazon S3, Backblaze
B2, Wasabi and MinIO each fill in their own endpoint, region and addressing
style from one blank, and **Other S3-compatible storage** takes an endpoint
directly, so anything speaking the S3 API works whether or not it is on the
list.

There is one entry that is not S3: **Cloudflare R2 without keys**. You deploy
[a small Worker](gateway/README.md) to your own Cloudflare account, Cloudflare
binds it to your bucket, and the plugin then holds one bearer token instead of
an access key and secret. It is not encryption, the token still lives in your
vault in plain text, and your site build still needs a read-only R2 key of its
own. What it changes is what a leak reaches. See
[docs/security.md](docs/security.md), which is blunt about both halves.

Hosting has a picker of its own. Cloudflare Pages, Cloudflare Workers, Netlify
and Vercel each bring their own instructions, their own free-plan numbers and
their own warnings, and **Another host** covers anything that builds a Git
repository and gives you a deploy hook URL. The host is recognised from the hook
URL you paste, and it is never sent anywhere: it decides what the copy says, not
what the plugin does.

See [docs/other-providers.md](docs/other-providers.md) for both tables, the two
storage providers whose pricing fights this design, and what each host does
about redirects and site addresses.

## How publishing works

Content is content-addressed. Every file is stored under its own SHA-256, a
snapshot lists which hashes make up the site, and one small pointer file names
the live snapshot:

```
objects/<ab>/<sha256>        immutable, deduplicated, never overwritten
snapshots/<id>.json          immutable manifest: path → hash, slug, links
current.json                 the only mutable key
```

A publish uploads whatever is missing, writes a snapshot, and then commits by
replacing `current.json`. Everything before that last step is additive, which is
what gives you:

- **Interrupt it any time.** Quit mid-upload and the live site is untouched.
- **Retries are free.** Same content, same hash, same key. Nothing uploads twice.
- **Deleting needs no delete.** A file simply is not in the next snapshot.
- **Two devices cannot corrupt each other.** The commit is a compare-and-swap;
  the second one is rejected and told to re-scan.
- **Rollback is one small write.** Point `current.json` at an older snapshot.

See [docs/architecture.md](docs/architecture.md) for the details.

## Network access

Obsidian's developer policy requires plugins to disclose every network endpoint.
This plugin contacts exactly three, all of which you configure yourself:

| Endpoint | Why | When |
|---|---|---|
| Your storage endpoint (e.g. `https://<account>.r2.cloudflarestorage.com`), or your own Worker's address if you use the gateway | Read the current snapshot; upload notes and attachments | Scanning, publishing, cleanup |
| Your deploy hook URL | Ask your host to rebuild the site | After a successful publish |
| Your site URL, path `/_publish.json` | Check whether the new version is live | After triggering a build |

There is no telemetry, no analytics, and no server operated by this project.

## Credentials

Storage keys are kept in Obsidian's plugin settings, which means plain text
inside your vault, synced with it, and readable by any other plugin you install.
Obsidian cannot sandbox plugins and says so. The protection is scope rather than
secrecy: use a token limited to one bucket, give the build a separate read-only
token, and revoke either in one click. [docs/security.md](docs/security.md) is
the honest, complete version.

## Development

Node 22.18 or newer. The test suites import the TypeScript sources directly,
relying on Node stripping the types itself, so there is no build step and no
test-only toolchain to keep in sync.

```bash
npm install --prefix plugin
npm run check     # typecheck, both test suites, then the bundle
```

Or one piece at a time:

```bash
npm run typecheck
npm test          # no network, no Obsidian, no browser
npm run build     # produces plugin/main.js
```

The tests are the specification for the parts that must not break: atomic
commits, garbage-collection safety, link rewriting, the tick-to-outcome table in
the publish window, and the full build pipeline run as real subprocesses against
a stand-in bucket. `npm run check` is what CI runs, unchanged.

To try it in a vault, copy `manifest.json`, `main.js` and `styles.css` into
`<vault>/.obsidian/plugins/open-publish/`.

## Status

Phases 1 and 2 of the roadmap in `docs/architecture.md` are done: the plugin and
the Quartz starter are complete and tested. Phase 3 is next: a Worker gateway
and Deploy-to-Cloudflare button, rollback UI, and mobile.

Mobile is the honest caveat. `manifest.json` does not mark the plugin
desktop-only and the code avoids Node APIs, so it should work, but it has not
been verified on a device, and the status bar it uses to report a publish
running in the background does not exist there, leaving only notices.

## Licence

MIT.
