# Setup: Cloudflare R2 + Pages

The default path. About ten minutes, no terminal, nothing to clone.

You create two things in Cloudflare (a storage bucket and a Pages project) and
one thing in GitHub (a repository from a template). The plugin has a **Test**
button at each step, and each failure names the thing to fix.

Open **Settings → Open Publish → Open setup guide** in Obsidian to follow along.

## A. Storage

1. Cloudflare dashboard → **R2** → **Create bucket**. Name it something like
   `my-notes-publish`, and leave it **private**.
2. Note your **Account ID** from the R2 overview page. Your endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
3. **R2 → API Tokens → Create API token**, with permission **Object Read &
   Write**, scoped to **this bucket only**. Save the Access Key ID and Secret
   Access Key; Cloudflare shows the secret once. This pair goes in the plugin.
4. Create a **second** token, **Object Read only**, same bucket. This pair goes
   to the build environment in step C.

> Two tokens, because they carry very different risk. The read-only one only
> unlocks content already public on your website. The read-write one can replace
> your site.

**In Obsidian**, choose **Cloudflare R2** in the storage list, then fill in the
Account ID, the bucket and the read-write key pair. The plugin builds the
endpoint from the account ID and shows it underneath. Region and path-style
addressing are set for you, under **Advanced**.

Press **Test connection**. It writes a small object, reads it back, compares it
and deletes it, then makes one write with a deliberately stale `If-Match` that R2
has to reject. A pass means the token can do everything publishing needs, and
that two devices can publish safely.

## B. Site repository

5. Open the [jotter template](https://github.com/navidkashani/jotter) on GitHub
   and choose **Use this template → Create a new repository**.

   Your notes never enter this repository. It holds the site generator and the
   build scripts, and the build fetches your notes from your bucket. The
   repository is yours from that point on: edit `src/styles/custom.css` in
   GitHub's web editor to change how the site looks, or add your own component
   to `src/user/`. Commit, and your host rebuilds.

   **To take a new version later**, run **Actions → Update theme → Run
   workflow** in your own repository. It opens a pull request for you to review,
   and never writes to your default branch. See
   [jotter's updating guide](https://github.com/navidkashani/jotter/blob/main/docs/updating.md).

   You can make the repository private at the "Create a new repository" step,
   and everything above still works. Copying a template rather than forking is
   what allows that: a fork of a public repository is public for ever.

   <details>
   <summary>Prefer Quartz?</summary>

   Use the [Open Publish Quartz template](https://github.com/navidkashani/open-publish-quartz)
   instead, and read `public` wherever the steps below say `dist`. Its styling
   file is `quartz/styles/custom.scss`. It has no update button, because that
   repository is regenerated and force-pushed, so no merge from upstream
   survives. Updating means making a fresh copy.
   </details>

## C. Hosting

6. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**, and pick
   the repository you just created.
7. Build settings: framework preset **None**, build command `npm run build`,
   output directory `dist` (`public` if you chose Quartz).

   Get the output directory wrong and Cloudflare uploads an empty one, then
   reports a successful deploy.
8. **Settings → Environment variables.** Add these to **both** Production and
   Preview, using the **read-only** token from step 4:

   | Variable | Value |
   |---|---|
   | `OP_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
   | `OP_BUCKET` | your bucket name |
   | `OP_REGION` | `auto` |
   | `OP_ACCESS_KEY_ID` | read-only key ID |
   | `OP_SECRET_ACCESS_KEY` | read-only secret, mark it **encrypted** |
   | `OP_PREFIX` | only if you set a key prefix in the plugin |
   | `OP_SITE_URL` | the address readers use: `https://<project>.pages.dev`, or your own domain |

   The setup guide in Obsidian prints these with your own values filled in, and
   has a Copy button.

   **`OP_SITE_URL` is required, and the build stops without it.** Pages injects
   no variable carrying your site's stable address, and guessing one would tell
   search engines to drop your pages. [Troubleshooting](troubleshooting.md) has
   the long version.

> **The plugin never asks for the read-only key.** Only the build uses it. Paste
> it from Cloudflare straight into Cloudflare. [security.md](security.md)
> compares what the two tokens can do.

9. **Settings → Builds & deployments → Deploy hooks → Create deploy hook**. Use
   the branch your site is actually built from, usually `main`, and copy the URL.

   A hook on another branch deploys to a preview address while the plugin polls
   production, so the check waits ten minutes and finds nothing.

**In Obsidian**, paste the deploy hook URL and your `*.pages.dev` site URL, then
press **Check the site**. It reports which snapshot the site is serving, and
deliberately does not spend one of your 500 monthly builds.

10. Optional: **Custom domains → Set up a domain**. Cloudflare handles DNS and
    TLS.

    **Change `OP_SITE_URL` before you move DNS, not after.** Until you edit it,
    every canonical link, `og:url` and sitemap entry on the new domain still
    names `*.pages.dev`, and search engines read the new domain as a duplicate
    of the old one. If your site is served from a sub-path, add `OP_SITE_ROOT`
    as well, such as `/notes`.

## D. Publish

Choose what to publish, either way round:

- **Folders**: Settings → Open Publish → *Folders* → **Manage folders…**, then
  pick from the list. Each rule shows how many notes it currently publishes.
- **One note**: right click it, anywhere it lives, and choose **Publish with
  Open Publish**. These choices are listed under *Per-file choices* in settings.
- **Frontmatter**: put `publish: true` at the top of a note. This always wins
  over folder rules, and `publish: false` wins over everything.

Two more frontmatter keys change where a note sits in the navigation, and
neither changes whether it is published. `nav-order: 1` puts a note ahead of its
siblings; any number works, negatives sort first, and `1.5` slots between `1`
and `2`. `nav-hidden: true` takes a note out of the sidebar, and **it stays
published**: still at its own address, still in search, still linked to from
other pages.

**Settings → Open Publish → Customize navigation → Manage** does the same
without touching your notes. Drag a row, or use its Move up and Move down
buttons; on a phone, long-press it. A page moves only among its own siblings,
and your homepage is listed with the top-level notes. Frontmatter wins over
anything set here, and the dialog marks the rows where it has. The dialog stores
its order in `data.json`, so a second device that does not sync `.obsidian`
reverts it.

Then click the ribbon icon, or run the **Publish** command. You get a review
window listing new, changed, unchanged and removed files, and a **Publish**
button.

## What to expect

- **The first publish is the slow one.** It is fully resumable: quit and rerun,
  and it picks up where it left off.
- **Later publishes are quick.** Only new content uploads. Everything else is
  recognised by hash and skipped.
- **Builds are throttled.** The free plan allows 500 builds a month, so
  publishes inside a five-minute window upload content but hold the build back.
  Change this under *Minimum minutes between builds*.
- **Nothing changed means nothing is built.**

## A note on Cloudflare Pages

Pages is still the recommended path, and both starters are built for it.
Cloudflare's own
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
says Pages continues to be supported, but that new investment goes to Workers.

This design only needs a Git-connected build with environment variables and a
deploy hook, so the same flow works on Workers Builds, Netlify and Vercel. The
plugin's host picker swaps these instructions and the free-plan numbers for
whichever you pick. See [other-providers.md](other-providers.md).

If something goes wrong, [troubleshooting.md](troubleshooting.md) lists every
error message and what to do about it.
