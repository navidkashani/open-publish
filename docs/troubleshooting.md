# Troubleshooting

Every error the plugin shows names what broke and what to change. This page is
the longer version of each one.

## Storage

**"Storage rejected these credentials."**
The access key or secret is wrong, the token has been revoked, or it is scoped to
a different bucket. Create a new **Object Read & Write** token in R2 → API
Tokens, scoped to this bucket, and paste both halves again.

**"Bucket `<name>` was not found at this endpoint."**
The bucket name is misspelt, or the endpoint points somewhere else. The hint
names what to check for your provider: an account ID on R2, a region on S3, B2
and Wasabi. Pick your provider in **Settings → Storage** and the plugin builds
the endpoint for you. On **Other S3-compatible storage**, check it yourself: it
is a full URL, starting with `https://`.

**"Couldn't reach the storage endpoint."**
The request never reached a server. Check that you are online, and check the
endpoint for typos: a missing `https://` is the usual cause.

**"The site pointer changed while this publish was running."**
Another device published between your scan and your commit. Nothing was
overwritten and nothing was lost. Press **Rescan** to see their changes, then
publish.

**"This storage provider does not support conditional writes."**
Your provider does not implement `If-Match` on PUT, so the plugin falls back to
reading the pointer and warning before it writes. Publishing still works, but two
devices publishing at the same moment are less well protected. R2, S3, and MinIO
from 2024-09-13 onwards all support it. **Test connection** reports this, and
**Storage self-test** also checks the first-publish guard (`If-None-Match: *`),
which is the one MinIO got wrong before that date.

**"This is not the storage your site was published to."**
A warning, not an error: the endpoint, bucket, prefix or addressing style has
changed since your last publish. Publishing now uploads every file again, and the
review screen shows your whole vault as new, because the new bucket has nothing
to compare against. Your site also keeps building from the old storage until you
update your host's build variables. Moving deliberately is fine.

## Builds

**"The deploy hook was rejected."**
Two causes, and the hint under the message names the likelier one for your host.
A hook stops working if the hook, its branch, or the project is deleted; create a
new one and paste the new URL in.

On Netlify there is a second cause. The free plan covers about 20 deploys a
month, and once that is gone Netlify disables builds and the hook answers with an
error. Netlify does not document which status code, so the plugin cannot tell the
two apart. Check your billing page before recreating a hook that may be fine.

**"Uploaded successfully, but the site hasn't updated yet."**
Your content is committed and stored, and only the build did not finish inside
the ten minutes the plugin waited. **Republishing will not help**, because
nothing is left to upload. Open your host's build log. The usual causes:

- The build environment variables are missing or wrong. The log says
  `Missing environment variable(s): …`.
- A note broke the generator. The log names the file.
- The build queued behind another one. Most free plans run one build at a time.

Once it is fixed, use **Trigger a site build without publishing**, or press
**Rebuild site** on the "Your site is up to date" screen.

**"Content published. The last build started N minute(s) ago…"**
Build throttling, working as intended. Your content is live in storage, and the
build is held back to protect a limited monthly allowance. Adjust *Minimum
minutes between builds*, or trigger a build manually.

**"Nothing has changed since the last publish. No build needed."**
Not an error. No files and no site options changed, so no build was spent.

**"No content has been published yet: current.json is missing from the bucket."**
Expected, if you have not published yet. Connecting the repository starts a build
immediately and publishing is the last step, so the first build always fails this
way rather than putting an empty site at your address. Finish the guide, deploy
hook included, then publish once from Obsidian.

If you *have* published, the build is looking in the wrong place. It reads the
bucket directly, so its variables have to match the plugin's settings exactly.
The easiest to miss is `OP_PREFIX`: a vault publishing under a prefix writes
`current.json` inside it, and a build without that variable reads the bucket root
and finds nothing. Behind a Worker gateway, `OP_PREFIX` is your Worker's own
`PREFIX` followed by the vault's.

**Which build variables to mark as secret**
Only `OP_SECRET_ACCESS_KEY`. Encrypting the others breaks nothing, but most hosts
never show an encrypted value again, and those are exactly the values worth
checking when a build says the bucket looks empty. `OP_ACCESS_KEY_ID` is an
identifier for a read-only key that unlocks only what is already public.

## Content

**"N files would publish to the same URL."**
Two files produce the same address, usually `Note.md` and `note.md`. They coexist
on macOS and Windows and collide on the Linux build machine. Rename one, or give
one a different `permalink`.

**"`<file>` is N MB. 25.0 MB is the most a single file can be."**
A hard platform limit, and the tightest among the supported hosts, so it applies
everywhere. Compress the file, or serve it from your storage and link to it.

**"`<file>` is N MB … anything over 100 MB is refused."**
Obsidian's `requestUrl` has no streaming or multipart upload, so a file is held
whole in memory. Above 100 MB that is not safe to attempt.

**"N files selected. One update can hold about 20,000 files…"**
Narrow your include rules, or move to a paid plan on your host.

**The site builds, but the feed, sitemap or 404 page point at the wrong domain.**
Those three need an absolute address, and a custom domain added in your host's
dashboard does not reach the build. Set `OP_SITE_URL` in the build environment
variables, and `OP_SITE_ROOT` too if the site is served from a sub-path. See
[other-providers.md](other-providers.md#the-site-address).

**The build stops with "This build is running on Cloudflare Workers Builds…".**
Working as intended. Workers Builds provides no site address of its own, so
without `OP_SITE_URL` the site would be built as `example.com`. Set
`OP_SITE_URL` and build again.

**The build stops with "This build is running on Cloudflare Pages, and the only
address it was given…".**
Also working as intended, and this stop prevents the worst failure in the whole
pipeline.

Pages injects five variables, and none of them carries your site's stable
address. `CF_PAGES_URL` is the *deployment's* own URL: a fresh hash subdomain
minted on every deploy, such as `2f8bfad6.my-notes.pages.dev`, which Cloudflare
serves with `x-robots-tag: noindex`. Used as the site address, it becomes every
page's canonical link, its `og:url`, every sitemap entry and the `Sitemap:` line
in `robots.txt`. The whole site would then tell search engines that the real
version of each page lives at a host they are forbidden to index, and the
documented result is pages dropping out of the index.

Nothing can derive the right answer, so the build asks for it. Add `OP_SITE_URL`
under **Settings → Variables and secrets**, for Production and Preview both, with
the address readers actually use, and deploy again.

**The publish waits ten minutes and then says "Saved, still waiting".**
Usually the site URL. If it names a site that has never been built, every poll
gets a 404, which the plugin reads as "not built yet" rather than as an error.
**Check the site** in settings diagnoses this instantly. The other cause is a
deploy hook created for a branch other than the one the live site is built from:
the build deploys to a preview address while the plugin polls production.

**I used Obsidian Publish and the import does not appear.**
The row appears only when `<config dir>/publish.json` exists, and Obsidian
Publish writes that file when a site has folder filters set. Three ordinary
reasons it is not there: the vault synced without its configuration directory,
the Publish setup never got as far as choosing folders, or the site selects notes
one at a time. Those per-note choices live on Obsidian's servers, and this plugin
does not talk to Obsidian. Add the folders in **Manage folders...** instead,
where the count beside each one tells you whether you picked the right ones.

**Notes my Publish site had, that the import did not bring across.**
Publish keeps single-note selections on its own servers. The import offers what
it can infer instead: every note carrying a `permalink` that the imported folders
would not publish, with the boxes empty for you to tick. A note published
individually *without* a permalink leaves no trace in the vault, so compare the
result against your live site, and add anything missing with a right click and
**Publish with Open Publish**.

**The import lists folders that no longer exist.**
They were renamed or deleted after Obsidian Publish last saved its filters. The
preview marks each one, and importing them is harmless, because a rule that names
nothing publishes nothing. Remove them in **Manage folders...** whenever you
like. Folder names are case sensitive here, as they are in Obsidian Publish, so
`notes` and `Notes` are different folders and the wrong one reads 0 notes.

## Site problems

**Images are missing.**
Check that *Include embedded attachments automatically* is on in settings. With
it off, images in a folder outside your include rules are not published.

**A link renders as plain text instead of a link.**
That note is not published. Use **Add linked** in the publish window to include
the notes your published notes point at. Plain text is deliberate: a link to a
page that is not there is worse than no link.

**An old URL now 404s.**
Renames generate redirects automatically, but only when the note was renamed
*and* its content is unchanged. A rename plus an edit in the same publish looks
like a delete and an add. Publish the rename first, then the edit.

**Every URL from my Obsidian Publish site 404s.**
Obsidian Publish serves `Company/About us.md` at `/Company/About+us`, and this
plugin serves it at `/company/about-us`. Set **Site URLs** to "Clean, keep my old
links working" and publish once. Every old address then gets a page forwarding to
the new one, marked canonical. This only helps if your site is on the same domain
Obsidian Publish served: nothing you host can redirect
`publish.obsidian.md/username/…`.

**The build fails with "downloaded corrupted".**
An object in storage does not match the hash recorded for it. The build refuses
to deploy it rather than serve corrupt content. Publish again from Obsidian to
re-upload.

## Everything else

**"A publish is running."**
One publish happens at a time per vault. A second click joins the running one.

**Cleanup refuses to run.**
Cleanup will not start while a publish is in progress, because deleting an object
a running build is about to read would break a deploy. Wait for the publish to
finish.

**The plugin was reinstalled and settings are gone.**
Re-enter the credentials. Nothing else needs restoring, because every scan reads
`current.json` from the bucket. The first scan is just slower.
