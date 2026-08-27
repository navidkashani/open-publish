#!/usr/bin/env node
/**
 * Assemble the publishable template repository.
 *
 *   Quartz (at a pinned tag, with its history)  +  this overlay  =  the template
 *
 * The template is a genuine Quartz fork rather than a thin repo that clones
 * Quartz at build time. That costs a heavier repository and turns Quartz
 * upgrades into a merge, and buys three things that matter more:
 *
 *   1. Every Quartz tutorial, doc page and forum answer applies directly.
 *      `quartz/styles/custom.scss` and all 27 components are simply present.
 *      In the clone-at-build-time shape they were not, so custom CSS silently
 *      did nothing: no error, no effect.
 *   2. Builds stop depending on github.com and the npm registry on every
 *      publish, and Cloudflare can cache node_modules against the root lockfile.
 *   3. `git pull upstream v4` is Quartz's own documented upgrade path, with
 *      community support behind it.
 *
 * Usage:
 *   node assemble.mjs <target-dir> [--ref v4.5.1] [--push git@github.com:you/repo.git]
 */

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const OVERLAY = dirname(fileURLToPath(import.meta.url))
const UPSTREAM = 'https://github.com/jackyzha0/quartz.git'

const args = process.argv.slice(2)
const target = resolve(args[0] ?? 'template-repo')
const ref = valueOf('--ref') ?? 'v4.5.1'
const pushTo = valueOf('--push')

function valueOf(flag) {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

const run = (cmd, cmdArgs, cwd = target) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit' })

// Files this overlay owns. Anything else comes from Quartz and stays mergeable.
export const OVERLAY_FILES = [
  'scripts',
  'quartz.config.ts',
  'quartz.layout.ts',
  'op-site.ts',
  'wrangler.jsonc',
  'README.md',
]

/**
 * Overlay files that are deliberately not shipped. Anything in the overlay that
 * is in neither list fails `assemble.test.mjs`, because the alternative is what
 * already happened once: `wrangler.jsonc` was added to the overlay, left out of
 * the list above, and was simply missing from the template for six commits with
 * nothing to say so.
 */
export const NOT_SHIPPED = [
  // Builds the template; does not belong inside it.
  'assemble.mjs',
  // Tests assemble.mjs, so it goes wherever assemble.mjs does: nowhere.
  'assemble.test.mjs',
  // Quartz's own package.json is merged instead, by mergePackageJson below.
  'package.json',
  // For running the overlay's tests in place. The template's is merged from
  // Quartz's by mergeGitignore below.
  '.gitignore',
]

async function main() {
  if (existsSync(target)) await rm(target, { recursive: true, force: true })

  // Full history, not a shallow clone: `git pull upstream v4` has to work later.
  console.log(`Cloning Quartz ${ref}…`)
  run('git', ['clone', '--quiet', UPSTREAM, target], process.cwd())
  run('git', ['checkout', '--quiet', ref])
  run('git', ['checkout', '--quiet', '-b', 'main'])
  run('git', ['remote', 'rename', 'origin', 'upstream'])

  console.log('Applying the Open Publish overlay…')
  for (const file of OVERLAY_FILES) {
    const from = join(OVERLAY, file)
    if (!existsSync(from)) continue
    await rm(join(target, file), { recursive: true, force: true })
    await cp(from, join(target, file), { recursive: true })
  }
  // Belt and braces: assemble.mjs lives beside `scripts/`, not in it, but an
  // older overlay put it there and a stale copy inside the template is worse
  // than a missing one.
  await rm(join(target, 'scripts', 'assemble.mjs'), { force: true })

  // Quartz ships an empty content/ for its own site. Ours is fetched per build.
  await rm(join(target, 'content'), { recursive: true, force: true })
  await mkdir(join(target, 'content'), { recursive: true })
  await writeFile(join(target, 'content', '.gitkeep'), '')

  await mergePackageJson()
  await mergeGitignore()

  run('git', ['add', '-A'])
  run('git', [
    '-c', 'user.email=hi@wasl.to',
    '-c', 'user.name=Navid Kashani',
    'commit', '--quiet', '-m',
    `Open Publish starter on Quartz ${ref}\n\n` +
      'Builds a site from a snapshot published to object storage by the Open\n' +
      'Publish Obsidian plugin. Notes are fetched at build time and are never\n' +
      'committed here.\n\n' +
      'Quartz history is preserved, so upstream updates are a normal merge:\n' +
      '  git fetch upstream && git merge upstream/v4',
  ])

  if (pushTo) {
    // The push is a force, and has to be: the template is regenerated from this
    // overlay every time, so its tip commit is replaced rather than added to.
    // That is safe for the people using it, because "Use this template" gives
    // them a fresh history and their `upstream` points at Quartz, not at here.
    // It is not safe for a commit made *on* the template and never brought
    // back, so name what is about to be overwritten instead of overwriting it
    // quietly.
    console.log(`Pushing to ${pushTo}…`)
    run('git', ['remote', 'add', 'origin', pushTo])
    reportReplacedTip()
    run('git', ['push', '--force', '--quiet', '-u', 'origin', 'main'])
  }

  console.log(`\nAssembled at ${target}`)
}

/**
 * Print the remote's current tip, so a commit made on the template and never
 * backported into this overlay is visible in the log of the run that discards
 * it. Best effort: a remote with no `main` yet is the normal first push.
 */
function reportReplacedTip() {
  try {
    run('git', ['fetch', '--quiet', '--depth', '1', 'origin', 'main'])
    const tip = execFileSync('git', ['log', '-1', '--format=%h %ad %s', '--date=short', 'FETCH_HEAD'], {
      cwd: target,
      encoding: 'utf8',
    }).trim()
    console.log(`  replacing: ${tip}`)
  } catch {
    console.log('  no existing main on the remote; this is the first push.')
  }
}

/** Keep Quartz's dependencies and bin; add the scripts the host and we need. */
async function mergePackageJson() {
  const path = join(target, 'package.json')
  const pkg = JSON.parse(await readFile(path, 'utf8'))

  pkg.scripts = {
    ...pkg.scripts,
    // What the host runs. Must stay `npm run build` -> output `public`.
    build: 'node scripts/fetch-content.mjs && node scripts/build-site.mjs && node scripts/finalize.mjs',
    fetch: 'node scripts/fetch-content.mjs',
    finalize: 'node scripts/finalize.mjs',
    verify: 'node scripts/verify-build.mjs',
    // Quartz already owns `test`, so ours is namespaced rather than clobbering it.
    'test:starter': 'node --test scripts/*.test.mjs',
  }
  await writeFile(path, JSON.stringify(pkg, null, 2) + '\n')
}

async function mergeGitignore() {
  const path = join(target, '.gitignore')
  const existing = await readFile(path, 'utf8').catch(() => '')
  const additions = [
    '',
    '# Open Publish: fetched from your bucket on every build, never committed.',
    'content/*',
    '!content/.gitkeep',
    '.op-build-state.json',
    '',
    '# Note: op-site.ts is regenerated on every build and is NOT ignored. The',
    '# default copy is committed on purpose, as the fallback for a build that',
    '# runs before anything has been published.',
  ]
  await writeFile(path, existing.trimEnd() + '\n' + additions.join('\n') + '\n')
}

// Only when run as a command. Importing this file reads the two lists above and
// must not assemble anything.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
