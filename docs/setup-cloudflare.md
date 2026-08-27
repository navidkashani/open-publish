# Setup: Cloudflare R2 + Pages

The default path. About ten minutes, no terminal, nothing to clone.

You will create two things in Cloudflare (a storage bucket and a Pages project)
and one thing in GitHub (a repository from a template). The plugin has a **Test**
button at each step that fails with a specific, fixable message.

Open **Settings → Open Publish → Open setup guide** in Obsidian to follow along.

---

## A. Storage

1. Cloudflare dashboard → **R2** → **Create bucket**. Name it something like
   `my-notes-publish`. Leave it **private**: nothing needs public access.
2. Note your **Account ID** from the R2 overview page. Your endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.
3. **R2 → API Tokens → Create API token**:
   - Permission: **Object Read & Write**
   - Scope: **this bucket only**

   Save the Access Key ID and Secret Access Key. This pair goes in the plugin.
4. Create a **second** token, this time **Object Read only**, same bucket. This
   pair goes to the build environment in step C.

> Two tokens because they carry very different risk. The read-only one only
> unlocks content that is already public on your website. The read-write one can
> replace your site, so it stays scoped to a single bucket.

**In Obsidian**, choose **Cloudflare R2** in the storage list, then fill in the
Account ID, the bucket and the read-write key pair. The endpoint is built from
the account ID and shown underneath, so there is no URL to type. Region and
path-style addressing are set for you and live under **Advanced**, which opens
by itself if anything in there is not R2's default.

Press **Test connection**. It writes a small object, reads it back, compares it,
deletes it, and then makes one write with a deliberately stale `If-Match` that
R2 has to reject, so a pass means the token really can do everything publishing
needs and that two devices can publish safely.

---

## B. Site repository

5. Open the [Open Publish Quartz template](https://github.com/navidkashani/open-publish-quartz)
   on GitHub and choose **Use this template → Create a new repository**.

   One button in the browser. Nothing to clone, nothing to install. Your notes
   never enter this repository: it holds only the site generator and the build
   scripts, and your notes are fetched from your bucket at build time.

   The repository is yours from that point on. If you later want to change the
   look of the site, you can edit `quartz/styles/custom.scss` **directly in
   GitHub's web editor**. Commit, and your host rebuilds. Still no terminal.

---

## C. Hosting

6. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**, and pick
   the repository you just created.
7. Build settings:
   - Framework preset: **None**
   - Build command: `npm run build`
   - Output directory: `public`
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

   The setup guide in Obsidian prints these with your own values filled in, and
   has a Copy button.

> **Why the plugin does not ask for the read-only key.** It never uses it: only
> the build does. Keeping a copy in `data.json` would put both tokens in the same
> place, sync the pair to your other devices, and expose both to any other plugin
> you install, all for zero benefit. Paste it from Cloudflare straight into
> Cloudflare. The plugin only ever holds the read-write token.

| | Lives in | Can do | If it leaks |
|---|---|---|---|
| Read-write token | The plugin, on your devices | Replace your site | Serious: revoke it |
| Read-only token | The build environment | Read published content | Near zero, unless the site is password protected |

9. **Settings → Builds & deployments → Deploy hooks → Create deploy hook**.
   Use the branch your site is actually built from, usually `main`. A hook on
   another branch deploys to a preview address while the plugin polls
   production, so the check waits the full ten minutes and finds nothing. Copy
   the URL.

**In Obsidian**, paste the deploy hook URL and your `*.pages.dev` site URL, then
press **Check the site**. This confirms the site responds and reports which snapshot
it is currently serving. It deliberately does not start a build: free plans
allow 500 a month, and a test button should not spend one uninvited.

10. Optional: **Custom domains → Set up a domain**. Cloudflare handles DNS and
    TLS.

    One extra step that is easy to miss. A custom domain moves the pages, but
    the build still learns its address from `CF_PAGES_URL`, so the feed, the
    sitemap and the 404 page keep pointing at `*.pages.dev`. Nothing fails, and
    nobody notices until someone subscribes. Add `OP_SITE_URL` with your real
    address to the environment variables from step 8. If the site is served
    from a sub-path rather than a domain root, add `OP_SITE_ROOT` as well, e.g.
    `/notes`.

---

## D. Publish

Choose what to publish, either way round:

- **Folders**: Settings → Open Publish → *Folders* → **Manage folders…**, then
  pick from the list. Each rule shows how many notes it currently publishes,
  so a rule that has stopped matching says so on the spot.
- **Frontmatter**: put `publish: true` at the top of a note. This always wins
  over folder rules, and `publish: false` always wins over everything.

Then click the ribbon icon (or run the **Publish** command). You get a review
window listing new, changed, unchanged and removed files, and a **Publish**
button. The first publish uploads everything; later ones upload only what
actually changed.

---

## What to expect

- **The first publish is the slow one.** Files upload one per request, four at a
  time. A large vault with lots of attachments can take a while. It is fully
  resumable: quit and rerun, and it picks up where it left off.
- **Later publishes are quick.** Only new content uploads. Everything else is
  recognised by hash and skipped.
- **Builds are throttled.** Cloudflare Pages' free plan allows 500 builds a
  month and one at a time, so publishes inside a five-minute window upload
  content but hold the build back. Change this under *Minimum minutes between
  builds*.
- **Nothing changed means nothing is built.** A publish with no differences
  does not spend a build.

## A note on Cloudflare Pages

Pages is still the recommended path, and the starter is built for it. Worth
knowing where Cloudflare is going, though, in their own words from the
[migration guide](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/):
Pages continues to be supported, but all new investment, optimisation and
feature work goes to Workers.

Because this design only needs "a Git-connected build with environment variables
and a deploy hook", the identical flow works on Workers Builds, Netlify and
Vercel, and the plugin has a host picker that swaps these instructions and the
free-plan numbers for whichever you pick. Workers Builds needs one thing extra:
it reports no site address, so `OP_SITE_URL` is required rather than optional.
See [other-providers.md](other-providers.md).

If something goes wrong, [troubleshooting.md](troubleshooting.md) lists every
error message and what to do about it.
