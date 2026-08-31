/**
 * The host catalogue is copy, defaults and warnings, so the only things worth
 * proving about it are the ones that would quietly mislabel somebody's host:
 * that a real hook URL is recognised, that no two patterns can claim the same
 * URL, and that a near miss is refused rather than guessed at.
 *
 * The last one matters more here than it did for storage. A mislabelled host
 * shows the wrong free plan next to the two controls that spend it.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HOSTS, docsHook, hostById, inferHost, isHostId, rejectedHookHint } from '../src/builders/hosts.ts'
import { STARTERS } from '../src/builders/starters.ts'

/**
 * A real hook URL shape per host, so inference is tested on what people paste.
 *
 * The Cloudflare id is a UUID, hyphens and all, checked against a live Pages
 * deploy hook. A pattern that only allowed hex would have called the host we
 * recommend "Another host" for every user of it.
 */
const SAMPLES = {
  'cloudflare-pages': 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/597b2170-bce9-45c4-81aa-e728dfdfbd00',
  'cloudflare-workers': 'https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/597b2170-bce9-45c4-81aa-e728dfdfbd00',
  netlify: 'https://api.netlify.com/build_hooks/68a1f0c2d3e4b5a6c7d8e9f0',
  vercel: 'https://api.vercel.com/v1/integrations/deploy/prj_AbC123/9f8e7d6c5b',
}

const recognised = HOSTS.filter((host) => host.hookPattern !== null)

test('every host has the copy each surface needs', () => {
  for (const host of HOSTS) {
    assert.ok(host.name, `${host.id}: no name`)
    assert.ok(host.summary.endsWith('.'), `${host.id}: summary is not a sentence`)
    assert.ok(host.allowance.endsWith('.'), `${host.id}: allowance line is not a sentence`)
    for (const starter of STARTERS) {
      assert.ok(
        host.setup(starter.build).length >= 3,
        `${host.id} on ${starter.id}: hosting steps are too thin to follow`,
      )
    }
    assert.ok(host.hookSetup.length >= 2, `${host.id}: deploy hook steps are too thin to follow`)
    assert.ok(host.rejectedHint.length > 0, `${host.id}: no hint for a rejected build request`)
    assert.match(host.siteUrlExample, /^https:\/\//, `${host.id}: the site address example is not an address`)
  }
  assert.equal(HOSTS.filter((host) => host.recommended).length, 1, 'exactly one recommendation')
  assert.equal(HOSTS[0].id, 'cloudflare-pages', 'the recommended one leads the list')
  assert.equal(HOSTS.at(-1).id, 'other', 'the escape hatch is last')
})

test('a real deploy hook URL is recognised as its own host', () => {
  for (const host of recognised) {
    const url = SAMPLES[host.id]
    assert.ok(url, `${host.id}: no sample hook URL in this test`)
    assert.equal(inferHost(url), host.id, `${host.id} does not recognise its own hook URL`)
  }
})

test('a sample hook URL only ever matches its own host', () => {
  for (const host of recognised) {
    for (const other of recognised) {
      if (other.id === host.id) continue
      assert.equal(other.hookPattern.test(SAMPLES[host.id]), false, `${other.id} claimed a ${host.id} hook URL`)
    }
  }
})

test('the two Cloudflare products are told apart, not merged', () => {
  // They differ by one path segment and by everything that matters: Workers
  // Builds sets no site address variable at all.
  assert.equal(inferHost(SAMPLES['cloudflare-pages']), 'cloudflare-pages')
  assert.equal(inferHost(SAMPLES['cloudflare-workers']), 'cloudflare-workers')
  assert.equal(hostById('cloudflare-pages').siteUrlVariable, 'CF_PAGES_URL')
  assert.equal(hostById('cloudflare-workers').siteUrlVariable, null, 'which is why the build has to be told')
})

test("a near miss is Another host, not Netlify's advice beside an attacker's URL", () => {
  const nearMisses = [
    'https://api.netlify.com.attacker.net/build_hooks/x',
    'https://api.netlify.com.evil.example/build_hooks/x',
    'http://api.netlify.com/build_hooks/x',
    'https://api.netlify.com/build_hooks',
    'https://notapi.netlify.com/build_hooks/x',
    'https://api.cloudflare.com.attacker.net/client/v4/pages/webhooks/deploy_hooks/x',
    'https://api.cloudflare.com/client/v4/pages/webhooks/x',
    'https://api.vercel.com.attacker.net/v1/integrations/deploy/a/b',
    'https://api.vercel.com/v1/integrations/deploy/a',
    'https://relay.example.com/build_hooks/x',
  ]
  for (const url of nearMisses) {
    assert.equal(inferHost(url), 'other', `${url} should not be recognised`)
  }
})

test('a trailing slash or a trigger parameter does not hide the host', () => {
  assert.equal(inferHost(`${SAMPLES.netlify}/`), 'netlify')
  assert.equal(inferHost(`${SAMPLES.netlify}?trigger_branch=main&trigger_title=note`), 'netlify')
  assert.equal(inferHost(`  ${SAMPLES.vercel}  `), 'vercel')
})

test('an empty or missing hook URL is Another host, with nothing claimed about it', () => {
  for (const input of ['', '   ', undefined]) {
    assert.equal(inferHost(input), 'other')
  }
})

test('an unknown host id is a label problem, never a crash', () => {
  assert.equal(hostById('fly').id, 'other')
  assert.equal(hostById(undefined).id, 'other')
  assert.equal(isHostId('fly'), false)
  assert.equal(isHostId('netlify'), true)
})

// --- the parts that talk to the rest of the repo -------------------------

test('a rejected build request is explained in terms of the host actually in use', () => {
  // The old hint said "it may have been deleted" to everyone, which sends a
  // Netlify user whose month simply ran out off to recreate a working hook.
  assert.match(rejectedHookHint(SAMPLES.netlify), /allowance/)
  assert.doesNotMatch(rejectedHookHint(SAMPLES['cloudflare-pages']), /allowance/)
  assert.match(rejectedHookHint(SAMPLES['cloudflare-pages']), /Create a new deploy hook/)
  assert.ok(rejectedHookHint(undefined).length > 0, 'an unrecognised host still gets a sentence')
})

test('a host that reports no address of its own says so, and asks for one', () => {
  // The escape hatch is where every unrecognised deploy hook lands, and it
  // reports nothing, so it needs OP_SITE_URL exactly as Workers Builds does.
  // It used to name OP_SITE_URL as though the host supplied it, which meant the
  // environment block skipped the one variable its own instructions ask for.
  for (const id of ['cloudflare-workers', 'other']) {
    const host = hostById(id)
    assert.equal(host.siteUrlVariable, null, `${id} does not report an address`)
    assert.match(host.siteUrlNote ?? '', /OP_SITE_URL/, `${id} has to ask for one`)
  }
  for (const id of ['cloudflare-pages', 'netlify', 'vercel']) {
    assert.ok(hostById(id).siteUrlVariable, `${id} reports its own address`)
    assert.equal(hostById(id).siteUrlNote, undefined, `${id} has nothing extra to ask for`)
  }
})

test('every host that asks for OP_SITE_URL says so in its setup steps too', () => {
  for (const host of HOSTS) {
    if (host.siteUrlVariable !== null) continue
    for (const starter of STARTERS) {
      assert.ok(
        host.setup(starter.build).some((line) => line.includes('OP_SITE_URL')),
        `${host.id} on ${starter.id}: the steps and the environment block disagree about OP_SITE_URL`,
      )
    }
  }
})

test('every host names the output directory of the starter actually chosen', () => {
  // The failure this prevents is the quiet one: a host told to publish `public`
  // for an Astro starter deploys an empty directory and reports success.
  for (const starter of STARTERS) {
    for (const host of HOSTS) {
      const steps = host.setup(starter.build).join(' ')
      const wrong = STARTERS.filter((other) => other.build.outputDir !== starter.build.outputDir)
      for (const other of wrong) {
        assert.equal(
          steps.includes(` ${other.build.outputDir}.`),
          false,
          `${host.id} on ${starter.id}: names ${other.id}'s output directory`,
        )
      }
      // Either the steps name it, or a config file in the repository declares
      // it. Cloudflare Workers with a starter that ships `wrangler.jsonc` is the
      // second case, and naming the directory there would be noise.
      const named = steps.includes(starter.build.outputDir)
      const declaredByConfig = starter.build.hasWranglerConfig && steps.includes('wrangler.jsonc')
      assert.ok(
        named || declaredByConfig,
        `${host.id} on ${starter.id}: neither the steps nor a config file say where the built site lands`,
      )
    }
  }
})

test('a starter with no wrangler.jsonc is told so on the host that needs one', () => {
  const workers = hostById('cloudflare-workers')
  const withConfig = STARTERS.find((starter) => starter.build.hasWranglerConfig)
  const without = STARTERS.find((starter) => !starter.build.hasWranglerConfig)

  assert.match(workers.setup(withConfig.build).join(' '), /comes from wrangler\.jsonc/)
  const bare = workers.setup(without.build).join(' ')
  assert.match(bare, /ships no wrangler\.jsonc/)
  assert.match(bare, /Cloudflare Pages instead/, 'and the way out is named, not left to be worked out')
})

test('only the hosts that can run out inside a month get a standing panel', () => {
  const noticed = HOSTS.filter((host) => host.allowanceNotice).map((host) => host.id)
  assert.deepEqual(noticed, ['netlify'], 'undifferentiated warnings train people to dismiss them')
})

test('the docs table and the catalogue cannot drift apart', () => {
  const docs = readFileSync(new URL('../../docs/other-providers.md', import.meta.url), 'utf8')
  const rows = docs.split('\n').filter((line) => line.startsWith('|'))

  for (const host of HOSTS) {
    const row = rows.find((line) => line.includes(host.name))
    assert.ok(row, `docs/other-providers.md has no row for ${host.name}`)

    const hook = docsHook(host.id)
    if (hook) assert.ok(row.includes(hook), `${host.name}: the docs hook URL is not \`${hook}\``)
  }

  assert.match(docs, /about 20 deploys/, "Netlify's free plan belongs in the docs too")
  assert.match(docs, /OP_SITE_URL/, 'the one variable that fixes a custom domain has to be written down')
})

test('the hook URL the docs print is one the plugin would recognise', () => {
  // A docs URL that our own inference calls "Another host" is a docs bug, and
  // this is the assertion that turns it into a test failure.
  for (const host of recognised) {
    const sample = docsHook(host.id).replace(/<[^>]+>/g, 'sample123')
    assert.equal(inferHost(sample), host.id, `${host.id}: the documented hook URL is not recognised`)
  }
})
