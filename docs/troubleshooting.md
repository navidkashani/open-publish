# Troubleshooting

Every error the plugin can show is a sentence describing what broke and what to
change. This page is the long version of each.

## Storage

**"Storage rejected these credentials."**
The access key or secret is wrong, the token has been revoked, or it is scoped to
a different bucket. Re-create an **Object Read & Write** token in
R2 → API Tokens, scoped to this bucket, and paste both halves again. Note that
the secret is shown only once at creation.

**"Bucket `<name>` was not found at this endpoint."**
Either the bucket name is misspelt or the endpoint points somewhere else. The
hint on this error names the thing to check for the provider you actually
chose: an account ID on R2, a region on S3, B2 and Wasabi.

Pick your provider in **Settings > Storage** and the endpoint is built from one
blank rather than typed, which is where most of these came from. If you are on
**Other S3-compatible storage**, check the endpoint yourself: it is a full URL,
starting with `https://`.

**"Couldn't reach the storage endpoint."**
A DNS or connectivity failure: the request never reached a server. Check the
endpoint for typos (a missing `https://` is the usual cause) and that you are
online.

**"The site pointer changed while this publish was running."**
Another device published between your scan and your commit. This is the
compare-and-swap doing its job: nothing was overwritten and nothing was lost.
Press **Rescan** to see their changes, then publish.

**"This storage provider does not support conditional writes."**
Your provider does not implement `If-Match` on PUT. The plugin falls back to
reading the pointer and warning before writing. Publishing still works; the
protection against two devices publishing simultaneously is weaker. R2, S3 and
MinIO from 2024-09-13 onwards all support it.

**Test connection** now reports this directly, and the **Publishing from two
devices** row in settings says what it found. **Storage self-test** goes one
further and also checks the first-publish guard (`If-None-Match: *`), which is
the one MinIO got wrong in the releases before that date.

**"This is not the storage your site was published to."**
Not an error: a warning that the endpoint, bucket, prefix or addressing style
has changed since your last publish. Three things happen if you publish now.
Every file uploads again, because the new bucket has nothing to compare
against. The review screen shows your whole vault as new, for the same reason.
And your site keeps building from the old storage until you update the
variables in your host's build settings, which step 4 of the setup guide lists.
Moving deliberately is fine. The warning is there because none of that is
visible otherwise.

## Builds

**"The deploy hook was rejected."**
Two causes, and the hint under the message names the likelier one for your host.

A hook stops working if the hook itself, its branch, or the project is deleted.
Create a new one and paste the new URL in.

On Netlify there is a second cause: the free plan covers about 20 deploys a
month, and once that is gone builds are disabled and the hook answers with an
error. Netlify does not document which status code, so the plugin cannot tell
the two apart, which is why it names both. Check your billing page before
recreating a hook that may be fine.

**"Uploaded successfully, but the site hasn't updated yet."**
Your content is committed and stored. Only the build did not finish in the ten
minutes the plugin waited. **Republishing will not help**: there is nothing left
to upload. Open your host's build log to see what the generator said. Common
causes:

- The build environment variables are missing or wrong. The build log will say
  `Missing environment variable(s): …`.
- A note broke the generator. The log names the file.
- The build queued behind another one. Most free plans run one build at a time.

Once fixed, use **Trigger a site build without publishing** rather than
publishing again, or open the publish window, which offers **Rebuild site** on
the "Your site is up to date" screen for exactly this case.

**"Content published. The last build started N minute(s) ago…"**
Build throttling, working as intended. Your content is live in storage; the
build is held back to protect a limited monthly allowance. Adjust *Minimum
minutes between builds* in settings, or trigger one manually.

**"Nothing has changed since the last publish. No build needed."**
Not an error. No files and no site options changed, so no build was spent.

**"No content has been published yet: current.json is missing from the bucket."**
Expected, if you have not published yet. This is the first build failing, and
setting up in the order the guide asks for guarantees it: connecting the
repository starts a build immediately, and publishing is the last thing you do.
The build stops rather than putting an empty site at your address. Finish the
guide, deploy hook included, then publish once from Obsidian: publishing asks
your host to rebuild by itself, and that build finds your notes. Only if you
turned **Trigger a build after publishing** off, or never pasted a hook, is
there a build to start by hand.

If you *have* published, the build is looking in the wrong place. It reads the
bucket directly, so its variables have to agree with the plugin's settings
exactly, and the one that is easiest to miss is `OP_PREFIX`: a vault publishing
under a prefix writes `current.json` inside it, and a build without that
variable reads the bucket root and finds nothing. Check `OP_ENDPOINT`,
`OP_BUCKET` and `OP_PREFIX` against **Settings > Storage** character by
character. Behind a Worker gateway, `OP_PREFIX` is your Worker's own `PREFIX`
followed by the vault's, and the plugin cannot fill either in for you.

**Which build variables to mark as secret**
Only `OP_SECRET_ACCESS_KEY`. Encrypting more of them breaks nothing, because
every host hands encrypted values to the build the same way it hands over plain
ones, but most hosts will not show you an encrypted value again afterwards, only
let you overwrite it. That hides exactly the values worth checking when a build
says the bucket looks empty. `OP_ENDPOINT`, `OP_BUCKET`, `OP_REGION`,
`OP_PREFIX` and `OP_SITE_URL` are not secrets, and `OP_ACCESS_KEY_ID` is an
identifier for a read-only key that only unlocks what is already public on your
site.

## Content

**"N files would publish to the same URL."**
Two files slugify to the same address, usually `Note.md` and `note.md`, which
coexist on macOS and Windows but collide on the Linux build machine, silently
overwriting one another. Rename one, or give one a different `permalink` in its
frontmatter.

**"`<file>` is N MB. 25.0 MB is the most a single file can be."**
A hard platform limit, and the tightest one among the supported hosts, so it is
applied everywhere. The file would not load on the live site even if uploaded.
Compress it, or serve it from your storage and link to it.

**"`<file>` is N MB … anything over 100 MB is refused."**
Obsidian's `requestUrl` has no streaming or multipart upload, so a file is held
whole in memory. Above 100 MB that is not safe to attempt.

**"N files selected. One update can hold about 20,000 files…"**
Narrow your include rules, or move to a paid plan on your host.

**The site builds, but the feed, sitemap or 404 page point at the wrong domain.**
Those three need an absolute address, and a custom domain added in your host's
dashboard does not reach the build. Set `OP_SITE_URL` to your real address in
the build environment variables. On a site served from a sub-path, set
`OP_SITE_ROOT` too, e.g. `/notes`. See
[other-providers.md](other-providers.md#the-site-address).

**The build stops with "This build is running on Cloudflare Workers Builds…".**
Working as intended. Workers Builds provides no site address of its own, so
without `OP_SITE_URL` the site would be built as `example.com` and nothing would
look wrong until someone opened the feed. Set `OP_SITE_URL` and build again.

**The publish waits ten minutes and then says "Saved, still waiting".**
Usually the site URL. If it names a site that has never been built, every poll
gets a 404, which the plugin correctly reads as "not built yet" rather than as
an error. **Check the site** in settings diagnoses the same thing instantly, so
it is worth pressing after any change to either address.

The other cause is a deploy hook created for a branch other than the one the
live site is built from. The build runs and deploys to a preview address while
the plugin polls production, so the two never meet.

**I used Obsidian Publish and the import does not appear.**
The row appears only when `<config dir>/publish.json` exists, which is the file
Obsidian Publish writes when a site has folder filters set. Three ordinary
reasons it is not there. The vault synced without its configuration directory:
Obsidian Sync carries core plugin settings by default, but iCloud and Git setups
frequently exclude the whole directory. The Publish setup never got as far as
choosing folders, so nothing was written. Or the site selects notes one at a
time. Those choices live on Obsidian's servers rather than in your vault, and
this plugin does not talk to Obsidian, so it cannot see them.

If you moved your configuration directory, the plugin follows it: the path comes
from the vault, never from a hardcoded `.obsidian`. Nothing is lost either way.
Add the folders in **Manage folders...**, where the count beside each one tells
you immediately whether you picked the right ones.

**Notes my Publish site had, that the import did not bring across.**
Publish also lets you publish single notes, and it keeps those selections on its
own servers. The import offers what it can infer instead: every note carrying a
`permalink` that the imported folders would not publish, with the boxes empty
for you to tick. A permalink is evidence rather than proof, and a note Publish
published individually *without* one leaves no trace in the vault at all, so
compare the result against your live site. Anything still missing goes on with a
right click on the note and **Publish with Open Publish**.

**The import lists folders that no longer exist.**
They were renamed or deleted after Obsidian Publish last saved its filters. The
preview marks each one, and importing them is harmless: a rule that names nothing
publishes nothing. Remove them in **Manage folders...** whenever you like.

Note that folder names are case sensitive here, as they are in Obsidian Publish,
so `notes` and `Notes` are different folders and the wrong one reads 0 notes.

## Site problems

**Images are missing.**
Check that *Include embedded attachments automatically* is on in settings. With
it off, images in a folder outside your include rules are not published. This is
the single most common cause of a broken-looking site.

**A link renders as plain text instead of a link.**
That note is not published. Use **Add linked** in the publish window to include
the notes your published notes point at. It is offered on the review screen and
on the "Your site is up to date" screen, which is where a site whose content has
stopped changing but whose links are broken actually sits. Rendering plain text
is deliberate: a link to a page that does not exist is worse than no link.

**An old URL now 404s.**
Renames generate redirects automatically, but only when the plugin can see both
snapshots: that is, if the note was renamed *and* the content is unchanged. A
rename plus an edit in the same publish looks like a delete and an add. Publish
the rename first, then the edit.

**Every URL from my Obsidian Publish site 404s.**
Obsidian Publish serves `Company/About us.md` at `/Company/About+us`; this plugin
serves it at `/company/about-us`. Set **Site URLs** to "Clean, keep my old links
working" in settings and publish once: every old address gets a page that
forwards to the new one, marked canonical so search engines follow. It only
helps if your site is on the same domain Obsidian Publish served. Links to
`publish.obsidian.md/username/…` point at Obsidian's servers, and nothing you
host can redirect those.

**The build fails with "downloaded corrupted".**
An object in storage does not match the hash recorded for it. The build refuses
to deploy it rather than serve corrupt content. Publish again from Obsidian to
re-upload.

## Everything else

**"A publish is running."**
One publish happens at a time per vault. A second click joins the running one.

**Cleanup refuses to run.**
Garbage collection will not start while a publish is in progress, because
deleting an object a running build is about to read would break a deploy that
otherwise succeeded. Wait for the publish to finish.

**The plugin was reinstalled and settings are gone.**
Re-enter the credentials. Nothing else needs restoring: every scan reads
`current.json` from the bucket, so the diff will be correct immediately. The
hash cache rebuilds itself; the first scan is just slower.
