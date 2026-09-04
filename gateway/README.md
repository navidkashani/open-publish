# Open Publish gateway

A Cloudflare Worker that lets the Obsidian plugin reach your R2 bucket **without
holding a storage key**. Cloudflare binds the Worker to your bucket on its side,
so no S3 credential exists on your device. The plugin holds one bearer token, and
that token reaches this Worker and nothing else.

## What this does and does not fix

The secret does not disappear. The token sits where the key did: Obsidian's
keychain, out of your vault, readable by every other plugin you install.
**Nothing this Worker does is encryption.** What changes is how much a leaked
credential can reach.

| | Direct R2 keys | This gateway |
|---|---|---|
| What the plugin holds | An access key and secret | One bearer token |
| What a leak reaches | The bucket, with whatever the token was scoped to | This Worker, which reaches one bucket, or one prefix of it if you set `PREFIX` |
| What it can do there | Anything the key was cut for | Five operations, on keys the Worker chooses |
| Rotating it | Create a token, scope it, replace two fields | `wrangler secret put TOKEN`, replace one field |

That is a real improvement in reach. It is not secrecy. Read
[docs/security.md](../docs/security.md) for the whole position.

## Deploying it

You need a Cloudflare account, an R2 bucket, and
[Wrangler](https://developers.cloudflare.com/workers/wrangler/).

1. **Point it at your bucket.** In `wrangler.jsonc`, change `bucket_name` to the
   bucket your notes are already published to.

   This is the one mistake here that fails quietly. A *new* bucket deploys
   perfectly and then builds a site with nothing in it.

2. **Deploy.**

   ```sh
   npx wrangler deploy
   ```

   Wrangler prints the address, such as
   `https://open-publish-gateway.your-subdomain.workers.dev`.

3. **Set the token.** Invent one; nobody issues it.

   ```sh
   openssl rand -base64 32
   npx wrangler secret put TOKEN
   ```

   While you are in `wrangler.jsonc`, decide about `PREFIX`. It ships empty, so
   the token reaches the whole bucket. If your site lives under a key prefix,
   set `PREFIX` to the same value your build uses for `OP_PREFIX`, and a stolen
   token cannot reach the rest of the bucket.

4. **Tell the plugin.** In Obsidian, **Settings → Open Publish → Storage**,
   choose **Cloudflare R2 without keys**, and paste the address and the token.
   Press **Test connection**.

5. **Run the self-test once.** **Settings → Maintenance → Run self-test**. Do
   not skip this one. **Test connection** checks the write guard that protects
   every publish after the first, but not the first-publish guard, which rests
   on R2 honouring a wildcard `If-None-Match`. R2's Workers bindings got that
   wrong for a period, and the self-test is the only thing that exercises it. If
   it prints `first-publish guard: ok`, this gateway is as safe as talking to R2
   directly.

Then publish as usual.

**Your site build still needs an R2 key.** It reads the bucket directly with its
own read-only key, and this Worker is not in that path. That key only unlocks
content already public on your site, and it never passes through Obsidian.

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

This is deliberately not the S3 API. A Worker speaking S3 would have to verify
SigV4 signatures, and a subtle mistake there is an authentication bypass.

`If-Match` is what makes publishing from two devices safe: the write only
succeeds if nobody else changed the file first. `If-None-Match: *` guards a
first publish. Both go to R2 as HTTP conditional headers.

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
curl -si -XPUT localhost:8787/o/hello.txt -H "Authorization: Bearer $T" \
  -H 'If-Match: "not-the-etag"' -d nope                   # 412, nothing written
```
