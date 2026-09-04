# Credentials: the honest position

## Where your keys live

Your secret key lives in Obsidian's keychain, a store the app keeps outside your
vault. Everything else sits in `data.json` inside
`.obsidian/plugins/open-publish/`: the endpoint, the bucket, the access key ID
and the deploy hook URL.

Three things follow for the secret.

- **It does not sync.** It never travels to your other devices, and never
  reaches Obsidian Sync, iCloud, Dropbox or a Git repository. You enter it once
  on each device you publish from.
- **Your operating system encrypts it at rest, where it can:** macOS Keychain,
  Windows DPAPI, or a Linux keyring such as gnome-keyring or kwallet. Obsidian
  warns you on the field and at startup when it cannot, and stores the value
  unencrypted in that case. That encryption has a limit. Your operating system
  unlocks it for Obsidian automatically, so anything running as you can ask for
  the value and get it. It protects the key from a copied disk, not from
  software on the machine.
- **Every other plugin you install can read it.** This is the one that matters.
  Obsidian's keychain is a single shared store, handed to every plugin as the
  same object, and the calls to list and read it are public API. Obsidian cannot
  sandbox plugins from one another, and says so in its own documentation.

The access key ID stays in `data.json` on purpose. It is an identifier rather
than a credential, and unlocks nothing on its own.

No plugin can honestly claim more than this. A plugin that says it "encrypts"
your keys for you is storing the decryption key next to them.

## So the protection is scope, not secrecy

Assume the key can leak. Make it not matter very much.

**Use bucket-scoped tokens, never account-wide ones.** Cloudflare R2 lets you
scope a token to a single bucket. A leaked token then reaches one bucket of
content you were publishing to the public internet anyway.

**Use two separate tokens.**

| | Lives in | Can do | If it leaks |
|---|---|---|---|
| Read-write token | The plugin, on your devices | Replace your site | Serious. Revoke it. |
| Read-only token | Your build environment | Read published content | Near zero |

The read-only token is near zero only because the bucket holds content that is
already public on your site. On a password-protected site, treat it as seriously
as the other one. The plugin stores only the read-write token: you paste the
read-only one straight into your host's environment variables, so it never
passes through Obsidian.

**Treat the deploy hook URL as a secret.** Anyone holding it can start builds on
your account. The worst case is wasted build minutes rather than lost data.

**Revoking takes effect immediately.** Cloudflare dashboard → **R2 → API
Tokens** → the token → **Delete**. Create a new token, then put the new secret
into the keychain entry your storage settings point at, under **Settings →
Keychain** or with the Change button on the field. Nothing else needs changing,
because the next scan reads the truth from your bucket. Repeat this on every
device you publish from, since the keychain does not sync.

## What the plugin does not do

- No telemetry, no analytics, no crash reporting.
- No server operated by this project.
- No network access beyond the three endpoints you configure yourself, listed in
  the [main README](../README.md#network-access).
- No writes to your notes, ever. Your choices live in plugin settings.
- **No access control on the site.** Two settings sound like access control.
  Neither is. *Discourage search engines* is a request to crawlers. Hiding a page
  in *Customize navigation* only takes it out of the sidebar: the page is still
  built, still served at its own address, still found by the site's search and
  still linked to from other pages. The only way to keep something private is not
  to publish it.

## The Worker gateway

**Cloudflare R2 without keys**, in **Settings → Storage**, removes the storage
key rather than hiding it. You deploy a small Worker to your own Cloudflare
account, Cloudflare binds it to your bucket, and the plugin holds one bearer
token for that Worker. No S3 credential sits on your device at all.

The token lives in exactly the same place the key did: Obsidian's keychain, out
of your vault, readable by every other plugin you install. Everything at the top
of this page is true of it too. **Nothing about the gateway is encryption.**

What changes is how much a leak can reach.
[The gateway's README](../gateway/README.md) has that comparison and the deploy
steps. The gateway has two limits:

- **Your site build still uses a read-only R2 key.** The build reads the bucket
  directly, and the gateway is not in that path.
- **It is Cloudflare-only.** Amazon S3, Backblaze and Wasabi have no equivalent.

R2 with direct keys stays the recommended entry, because the gateway needs a
deploy before it works.
