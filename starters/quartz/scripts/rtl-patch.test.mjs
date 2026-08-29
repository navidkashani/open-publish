/**
 * The three edits that give Quartz a direction concept.
 *
 * Worth testing on their own because they are string replacements against files
 * this repository does not own, run in three different places, and every way
 * they can go wrong is silent: an anchor that no longer matches produces a site
 * laid out backwards, and an anchor that matches twice produces a build failure
 * nowhere near the cause. Both of those happened before this file existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { patchDirection } from './lib/rtl-patch.mjs'

/** The three upstream lines, in the shape Quartz v4.5.1 has them. */
async function fakeCheckout(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'op-rtl-'))
  const files = {
    'quartz/cfg.ts': 'export interface GlobalConfiguration {\n  locale: ValidLocale\n}\n',
    'quartz/components/renderPage.tsx': '  const doc = (\n    <html lang={lang}>\n      <Head />\n',
    'quartz/styles/base.scss': '@use "./variables.scss" as *;\n@use "./callouts.scss";\n\nhtml {\n}\n',
    ...overrides,
  }
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), body)
  }
  return root
}

const read = (root, path) => readFile(join(root, path), 'utf8')

test('all three edits land where the site can see them', async () => {
  const root = await fakeCheckout()
  await patchDirection(root)

  assert.match(await read(root, 'quartz/cfg.ts'), /dir: 'ltr' \| 'rtl'/)
  assert.match(await read(root, 'quartz/components/renderPage.tsx'), /<html lang=\{lang\} dir=\{cfg\.dir\}>/)
  assert.match(await read(root, 'quartz/styles/base.scss'), /@use "\.\.\/\.\.\/styles\/op-rtl\.scss";/)
})

test('running it twice changes nothing the second time', async () => {
  // `build-site.mjs` reuses its Quartz checkout between builds, so the second
  // build always finds one that is already patched. The stylesheet anchor
  // survives its own replacement, so a naive check applied that edit again and
  // Sass rejected the duplicate `@use` with an error pointing at Quartz.
  const root = await fakeCheckout()
  await patchDirection(root)
  const once = await Promise.all(
    ['quartz/cfg.ts', 'quartz/components/renderPage.tsx', 'quartz/styles/base.scss'].map((p) => read(root, p)),
  )

  await patchDirection(root)
  const twice = await Promise.all(
    ['quartz/cfg.ts', 'quartz/components/renderPage.tsx', 'quartz/styles/base.scss'].map((p) => read(root, p)),
  )
  assert.deepEqual(twice, once)
})

test('an anchor Quartz has moved fails the build, naming the file', async () => {
  // The failure this whole module exists for. Silence here means a Persian
  // vault publishing an English layout, with nothing at all to say why.
  const root = await fakeCheckout({
    'quartz/components/renderPage.tsx': '  const doc = (\n    <html lang={lang} class="x">\n',
  })
  await assert.rejects(() => patchDirection(root), /renderPage\.tsx.*found 0/s)
})

test('an anchor that appears twice fails too, rather than picking one', async () => {
  const root = await fakeCheckout({
    'quartz/styles/base.scss': '@use "./callouts.scss";\n@use "./callouts.scss";\n',
  })
  await assert.rejects(() => patchDirection(root), /base\.scss.*found 2/s)
})
