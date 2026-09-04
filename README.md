# Open Publish

Publish part of your Obsidian vault as a website. You own the storage and you
pick the host. No subscription, no service in the middle.

```
Obsidian plugin  →  your object storage  →  deploy hook  →  your static host
```

Your notes go from Obsidian into your own bucket. Your host builds a site from
that bucket. Nothing passes through anyone else's server, and your notes never go
into Git.

## What it does

- **Publishes part of your vault.** Pick folders, put `publish: true` in a note's
  frontmatter, or publish one note from its right-click menu. Frontmatter wins.
- **Never writes to your notes.** The plugin only reads them.
- **Never breaks the live site.** The site switches to the new version all at
  once, or not at all.
- **Keeps `[[wikilinks]]` working.** The plugin ships Obsidian's own link
  resolution beside your notes. A link to a note you did not publish renders as
  plain text, never as a link to a page that is not there.
- **Brings your attachments along.** An image embedded by a published note gets
  published too, wherever it lives in your vault.
- **Keeps old addresses working.** Renaming a note leaves a redirect behind, and
  one setting redirects every URL your old Obsidian Publish site used.
- **Imports your Obsidian Publish folders** from `.obsidian/publish.json`, after
  showing you exactly what it would publish.
- **Gives you two themes.** [jotter](https://github.com/navidkashani/jotter) is
  an Astro theme and the recommended one. The Quartz starter lives here.
- **Carries your site options.** Navigation order, search, graph, backlinks,
  outline, tags, theme toggle, page metadata, previous/next links, hover
  previews, inline title, homepage and analytics. Hiding a page from the sidebar
  does not unpublish it.

## Install the plugin

There is no release yet, so you build the plugin from source. This is the only
step that needs a terminal, and you do it once. You need Node 22.18 or newer.

```bash
git clone https://github.com/navidkashani/open-publish.git
cd open-publish
npm install --prefix plugin
npm run build

mkdir -p "<vault>/.obsidian/plugins/open-publish"
cp plugin/main.js plugin/manifest.json plugin/styles.css \
   "<vault>/.obsidian/plugins/open-publish/"
```

Then turn on **Open Publish** under Settings → Community plugins.

## Get started

Follow **[docs/setup-cloudflare.md](docs/setup-cloudflare.md)**. It takes about
ten minutes and needs no terminal.

Cloudflare is the default, not a requirement. Storage can be R2, Amazon S3,
Backblaze B2, Wasabi, MinIO or any other S3 endpoint. Hosting can be Cloudflare
Pages, Cloudflare Workers, Netlify, Vercel or any host that builds a Git
repository and gives you a deploy hook URL. **Cloudflare R2 without keys** is the
one storage entry that is not S3: it uses [a small Worker](gateway/README.md) in
your own account, so the plugin holds a bearer token rather than a storage key.

## Guides

| Guide | What it covers |
|---|---|
| [Setup: Cloudflare R2 + Pages](docs/setup-cloudflare.md) | The default path, start to finish. |
| [Other providers](docs/other-providers.md) | Every storage provider and host, in tables. |
| [Troubleshooting](docs/troubleshooting.md) | Every error message, and what to do about it. |
| [Security](docs/security.md) | Where your key lives, and what a leak reaches. |
| [The gateway](gateway/README.md) | Reaching R2 without a storage key. |
| [Architecture](docs/architecture.md) | How it works inside, and why. |

## Repository layout

| Path | What it is |
|---|---|
| `plugin/` | The Obsidian plugin. TypeScript, no runtime dependencies. |
| `starters/quartz/` | The reference site template. Fetches a snapshot and builds it with Quartz. |
| `gateway/` | An optional Cloudflare Worker, so the plugin can reach R2 without a storage key. |
| `docs/` | The guides above. |
| `manifest.json` | The plugin manifest, and the copy to edit. The build copies it next to `main.js`. It lives at the repository root because that is where the Obsidian community directory reads it from. |

## How publishing works

Each file is stored under a name made from its own contents.

```
objects/<ab>/<sha256>        written once, never overwritten
snapshots/<id>.json          one version of the site: path → hash, slug, links
current.json                 the only file that ever changes
```

A publish uploads whatever is missing, writes a snapshot, then replaces
`current.json`. Everything before that last write only adds. So you can quit
mid-publish and leave the live site untouched, a retry re-uploads nothing, and
rolling back is one small write. See
[docs/architecture.md](docs/architecture.md).

## Network access

Obsidian's developer policy requires plugins to list every network endpoint. This
plugin contacts three, and you configure all of them yourself:

| Endpoint | Why | When |
|---|---|---|
| Your storage endpoint, or your own Worker's address if you use the gateway | Read the current snapshot, upload notes and attachments | Scanning, publishing, cleanup |
| Your deploy hook URL | Ask your host to rebuild the site | After a successful publish |
| Your site URL, path `/_publish.json` | Check whether the new version is live | After triggering a build |

There is no telemetry, no analytics, and no server run by this project.

## Credentials

Your secret key lives in Obsidian's keychain rather than in your vault, so it
does not sync with your notes and never reaches Git. Every other plugin you
install can still read it, because that keychain is one shared store. So limit
what a leaked key reaches: scope the token to one bucket, give your site build a
separate read-only token, and revoke either in one click.
[docs/security.md](docs/security.md) is the full version.

## Development

The test suites import the TypeScript sources directly and let Node strip the
types, so there is no build step before a test run.

```bash
npm install --prefix plugin
npm run check     # typecheck, both test suites, then the bundle
```

`npm run check` is what CI runs. To try your working copy in a vault, build it and
copy the three files across as in [Install the plugin](#install-the-plugin).

## Status

Phases 1 and 2 of the roadmap in [docs/architecture.md](docs/architecture.md)
are done. Phase 3 is underway: the Worker gateway and Site history have landed,
and the Deploy-to-Cloudflare button has not.

Mobile is the caveat. The plugin avoids Node APIs and handles the two places a
phone would notice, but nobody has run it on a device yet.

## Licence

MIT. See [LICENSE](LICENSE). The Quartz starter template carries Quartz's own
`LICENSE.txt`, also MIT, which stays as it is.
