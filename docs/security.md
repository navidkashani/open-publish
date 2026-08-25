# Credentials: the honest position

## What is actually true

Your storage keys are stored in `data.json` inside your vault's
`.obsidian/plugins/open-publish/` folder. That means:

- **Plain text on disk.** Not encrypted, not obfuscated.
- **Synced to your other devices**, if you sync your vault — including via
  Obsidian Sync, iCloud, Dropbox or Git.
- **Readable by every other plugin you have installed.** Obsidian cannot sandbox
  plugins from one another, and says so in its own documentation.

No plugin can honestly claim otherwise. Anything that says it "encrypts" your
keys is storing the decryption key next to them.

## So the protection is blast radius, not secrecy

Assume the key can leak. Make it not matter very much.

### Use bucket-scoped tokens, never account-wide ones

Cloudflare R2 supports scoping a token to a single bucket. Do that. A leaked
token then reaches one bucket containing content you were publishing to the
public internet anyway — not your account, not your other buckets, not your DNS.

### Use two separate tokens

They carry very different risk, and it is worth being precise about the
difference.

**The read-only token** lives in your build environment. It can only read
content that is already published to the public internet. If it leaks, the
impact is close to zero.

> The exception is a password-protected site, where the bucket holds content
> that is *not* public. There, treat the read-only token as seriously as the
> other one.

**The read-write token** lives in the plugin. It can overwrite `current.json`
and therefore replace your website with anything. This is the one that matters.
Keep it scoped to one bucket, and revoke it the moment you suspect a problem.

The plugin deliberately stores only the read-write token. The read-only one is
entered directly into your host's environment variables and never passes through
Obsidian — a credential the plugin has no use for is pure added risk, and keeping
both in `data.json` would undo the separation entirely.

### Treat the deploy hook URL as a secret

Anyone holding it can start builds on your account. The worst case is wasted
build minutes rather than data loss, but there is no reason to publish it.

### Revoking

Cloudflare dashboard → **R2 → API Tokens** → the token → **Delete**. Takes
effect immediately. Create a new one and paste it into the plugin; nothing else
needs to change, because no local state is load-bearing — the next scan reads
the truth from your bucket.

## What the plugin does not do

- No telemetry, no analytics, no crash reporting.
- No server operated by this project. There is nothing in the middle.
- No network access beyond the three endpoints you configure yourself, listed in
  the main README.
- No writes to your notes, ever. Selection state lives in plugin settings, not
  in your files.

## What is coming: the Worker gateway

The genuinely better answer, deferred to Phase 3 because it is
Cloudflare-specific.

Instead of holding S3 keys, the plugin would hold a single bearer token for a
small Worker that *you* own, deployed with a "Deploy to Cloudflare" button. The
Worker has an R2 binding, so no S3 credentials exist on your device at all. It
can also hold the deploy hook, enforce key prefixes, rate-limit, and perform the
pointer swap server-side.

That collapses onboarding *and* fixes the credential problem, which is why it
should become the recommended path once the direct-storage route is proven.
