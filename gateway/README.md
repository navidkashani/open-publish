# Open Publish gateway

A Cloudflare Worker that lets the Obsidian plugin reach your R2 bucket **without
holding a storage key**.

Cloudflare binds the Worker to your bucket on its side, so no S3 credential
exists on your device at all. The plugin holds one bearer token, and that token
reaches this Worker and nothing else.

## What this does and does not fix

It does not make the secret disappear. The token sits in exactly the same place
the keys did: `data.json` inside your vault, plain text, synced to your other
devices, readable by every other Obsidian plugin. **Nothing here is encryption**,
and anything claiming to encrypt keys on a device is storing the decryption key
next to them.

What changes is what a leak costs.

| | Direct R2 keys | This gateway |
|---|---|---|
| What the plugin holds | An access key and secret | One bearer token |
| What a leak reaches | The bucket, with whatever the token was scoped to | This Worker, which reaches one bucket, or one prefix of it if you set `PREFIX` |
| What it can do there | Anything the key was cut for | Five operations, on keys the Worker chooses |
| Rotating it | Create a token, scope it, replace two fields | `wrangler secret put TOKEN`, replace one field |

That is a real improvement in blast radius. It is not secrecy, and it should
never be described as if it were.

Read [docs/security.md](../docs/security.md) for the whole position.

## Deploying it

You need a Cloudflare account, an R2 bucket, and
[Wrangler](https://developers.cloudflare.com/workers/wrangler/).

1. **Point it at your bucket.** In `wrangler.jsonc`, change `bucket_name` to the
   bucket your notes are already published to.

   This is the one mistake here that fails quietly. A *new* bucket deploys
   perfectly and then builds a site with nothing in it, because your content is
   in the old one.

2. **Deploy.**

   ```sh
   npx wrangler deploy
   ```

   Wrangler prints the address, e.g.
   `https://open-publish-gateway.your-subdomain.workers.dev`.

3. **Set the token.** Invent one; it is not issued by anybody.

   ```sh
   openssl rand -base64 32
   npx wrangler secret put TOKEN
   ```

   While you are in `wrangler.jsonc`, decide about `PREFIX`. It ships empty,
   which means this token reaches the whole bucket. If your site lives under a
   key prefix already, set it to the same value and the token cannot reach
   anything else. See below.

4. **Tell the plugin.** In Obsidian, **Settings → Open Publish → Storage**,
   choose **Cloudflare R2 without keys**, and paste the address and the token.
   Press **Test connection**.

5. **Run the self-test once.** **Settings → Maintenance → Run self-test**. Do not
   skip this one.

   **Test connection** proves the token works and checks the compare-and-swap
   that protects every publish after the first. It does *not* check the
   first-publish guard, and that guard rests on R2 honouring a wildcard
   `If-None-Match`, which its Workers bindings got wrong for a period. The
   self-test is the only thing that exercises it. If it prints
   `first-publish guard: ok`, this gateway is as safe as talking to R2 directly,
   and if it does not, two devices publishing for the very first time at the
   same moment could overwrite each other.

Then publish as usual.

### If you use a key prefix

Set `PREFIX` in `wrangler.jsonc` to the same value your build uses for
`OP_PREFIX`. The Worker forces every key under it, which is what stops a stolen
token reaching the rest of the bucket. Leave it empty if you do not use one.

### What still needs an R2 key

Your **site build** reads the bucket directly, with its own read-only key, and
this Worker changes nothing about that. That key can only read content that is
already public on your site, and it never passes through Obsidian, so it is a
far weaker credential, but it does still exist, and the docs should not pretend
otherwise.

## The API

Every request carries `Authorization: Bearer <token>`, or gets a 401 with no
detail.

```
PUT    /o/<key>   body, optional If-Match / If-None-Match  -> 200 {etag} | 412
GET    /o/<key>                                            -> 200 body + ETag | 404
HEAD   /o/<key>                                            -> 200 size + ETag | 404
DELETE /o/<key>                                            -> 204
GET    /l?prefix=&cursor=                                  -> 200 {entries, cursor?}
```

Deliberately not S3. A Worker speaking the S3 API would need no plugin changes
at all, but it would have to verify SigV4 signatures, and a subtle mistake in
signature verification is an authentication bypass. A token comparison is a
handful of lines and obviously correct.

`If-Match` is the compare-and-swap that makes publishing from two devices safe,
and `If-None-Match: *` is what guards a first publish. Both are passed to R2 as
HTTP conditional headers, so the semantics are HTTP's rather than a
re-implementation of them.

## Working on it

```sh
npm test        # the Worker against a fake R2 binding. No install needed.
npm run dev     # wrangler dev, for curl
npm run deploy
```

By hand, against `npm run dev`:

```sh
T=your-token
curl -si -XPUT localhost:8787/o/hello.txt -H "Authorization: Bearer $T" -d hi
curl -si localhost:8787/o/hello.txt -H "Authorization: Bearer $T"
curl -si localhost:8787/o/hello.txt                       # 401
curl -si "localhost:8787/l?prefix=" -H "Authorization: Bearer $T"
curl -si -XPUT localhost:8787/o/hello.txt -H "Authorization: Bearer $T" \
  -H 'If-Match: "not-the-etag"' -d nope                   # 412, and nothing written
```
