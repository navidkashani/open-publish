# Credentials: the honest position

## What is actually true

Your secret key is stored in Obsidian's keychain, which is a store the app keeps
outside your vault. Everything else stays in `data.json` inside your vault's
`.obsidian/plugins/open-publish/` folder: the endpoint, the bucket, the access
key ID, the deploy hook URL.

For the secret, that means:

- **Not in your vault, so it does not sync.** It does not travel to your other
  devices, and it does not reach Obsidian Sync, iCloud, Dropbox, or a Git
  repository somebody pushes to GitHub. The cost is the obvious one: each device
  you publish from needs the key entered on it once.
- **Encrypted at rest by your operating system**, where your operating system
  offers that: macOS Keychain, Windows DPAPI, or a Linux keyring such as
  gnome-keyring or kwallet. Obsidian says so in its own keychain settings when
  it cannot, with a warning on the field and a notice on startup, and it stores
  the value unencrypted in that case. Be clear about what this kind of
  encryption is: your operating system unlocks it for Obsidian automatically, so
  anything running as you can ask Obsidian's keychain for it and get it. It
  protects the key from a copied disk, not from software on the machine.
- **Readable by every other plugin you have installed.** This one did not
  change, and it is the one that matters most. Obsidian's keychain is a single
  shared store on the same object every plugin is handed, and the calls to list
  and read it are public API. Obsidian cannot sandbox plugins from one another,
  and says so in its own documentation.

The access key ID is deliberately left in `data.json`. It is an identifier
rather than a credential, it unlocks nothing on its own, and having it visible
in a plain file is worth more than the nothing it costs.

No plugin can honestly claim more than this. Anything that says it "encrypts"
your keys *for you* is storing the decryption key next to them; what is
described above is your operating system's store, not this plugin's.

## So the protection is blast radius, not secrecy

Assume the key can leak. Make it not matter very much.

### Use bucket-scoped tokens, never account-wide ones

Cloudflare R2 supports scoping a token to a single bucket. Do that. A leaked
token then reaches one bucket containing content you were publishing to the
public internet anyway, not your account, not your other buckets, not your DNS.

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
Obsidian: a credential the plugin has no use for is pure added risk, and keeping
both in `data.json` would undo the separation entirely.

### Treat the deploy hook URL as a secret

Anyone holding it can start builds on your account. The worst case is wasted
build minutes rather than data loss, but there is no reason to publish it.

### Revoking

Cloudflare dashboard → **R2 → API Tokens** → the token → **Delete**. Takes
effect immediately. Create a new one, and put the new secret into the keychain
entry the plugin's storage settings point at, either in **Settings → Keychain**
in Obsidian or with the Change button on the field itself. The plugin picks it up on
the next request; nothing else needs to change, because no local state is
load-bearing: the next scan reads the truth from your bucket.

On every other device you publish from, the same rotation has to be done again,
because the keychain does not sync. That is the one place this arrangement costs
you work rather than saving it.

## What the plugin does not do

- No telemetry, no analytics, no crash reporting.
- No server operated by this project. There is nothing in the middle.
- No network access beyond the three endpoints you configure yourself, listed in
  the main README.
- No writes to your notes, ever. Selection state lives in plugin settings, not
  in your files.
- No access control on the site itself. Two settings sound like they might be
  one and neither is: *Discourage search engines* is a request to crawlers, and
  hiding a page in *Customize navigation* only takes it out of the sidebar. A
  hidden page is built, served at its own address, found by the site's own
  search and linked to from other pages. The only way to keep something private
  is not to publish it.

## The Worker gateway, which removes the key rather than hiding it

This exists now, for Cloudflare R2, as **Cloudflare R2 without keys** in
**Settings > Storage**.

You deploy a small Worker to your own Cloudflare account, and Cloudflare binds
it to your bucket on its side. The plugin then holds a single bearer token for
that Worker. No S3 credential is on your device at all.

**Read the next paragraph before believing this fixes the problem above.**

The token lives in exactly the same place the key did: Obsidian's keychain, out
of your vault, and readable by every other plugin you have installed. That last
clause is the one that survives every improvement, and it is the reason this
section exists. Everything at the top of this page is true of the token too.

What changes is blast radius, which is the same defence as before, applied
harder:

| | Direct R2 keys | The gateway |
|---|---|---|
| What the plugin holds | An access key and secret | One bearer token |
| What a leak reaches | The bucket, with whatever the token was scoped to | One Worker, which reaches one bucket, or one prefix of it if you set `PREFIX` |
| What it can do there | Anything the key was cut for | Five operations, on keys the Worker chooses |
| Where it lives | Obsidian's keychain, out of the vault | Obsidian's keychain, out of the vault |
| Revoking it | Create a token, scope it, replace the key in the keychain | One command, replace the value in the keychain |

Two things it does not do, said plainly because a picker entry could imply
otherwise:

- **Your site build still uses a read-only R2 key.** The build reads the bucket
  directly and the gateway is not in that path. That key only unlocks content
  already public on your site, and it never passes through Obsidian, so it is a
  far weaker credential. It has not gone away.
- **It is Cloudflare-only.** On Amazon S3, Backblaze or Wasabi there is no
  equivalent, and the setup at the top of this page remains the one to follow.

R2 stays the recommended entry. The gateway needs a deploy before it works,
which is a step new users should not meet first, and the direct route has more
miles on it. That balance is worth revisiting once this one does.

[The gateway's README](../gateway/README.md) has the four commands.
