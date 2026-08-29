/**
 * Teach Quartz to lay a site out right to left.
 *
 * Three one-line edits to upstream files, which is the whole of it. Quartz has
 * no direction concept at all, so the config type gains a field, the rendered
 * page gains an attribute, and the core stylesheet gains a reference to
 * `styles/op-rtl.scss`, the overlay sheet that does the actual mirroring.
 *
 * Here rather than in `assemble.mjs` because three callers need it and only one
 * of them has assemble.mjs available: the template ships without it, and both
 * `build-site.mjs` (when Quartz is cloned at build time rather than forked) and
 * `verify-build.mjs` build against a checkout nobody has assembled.
 *
 * Every replacement asserts it matched. A string patch against a file we do not
 * own is the fragile part of this repository: an upgrade that reflows any of
 * these three lines would otherwise make the edit a silent no-op, and a Persian
 * vault would publish `dir="ltr"` with nothing anywhere to say why. So this
 * fails the build loudly instead, naming the line that moved.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PATCHES = [
  {
    file: ['quartz', 'cfg.ts'],
    find: '  locale: ValidLocale\n}',
    replace:
      '  locale: ValidLocale\n' +
      '  /** Reading direction, from the published snapshot. Added by Open Publish. */\n' +
      "  dir: 'ltr' | 'rtl'\n}",
  },
  {
    file: ['quartz', 'components', 'renderPage.tsx'],
    find: '<html lang={lang}>',
    replace: '<html lang={lang} dir={cfg.dir}>',
  },
  {
    file: ['quartz', 'styles', 'base.scss'],
    find: '@use "./callouts.scss";',
    replace:
      '@use "./callouts.scss";\n' +
      '// Open Publish: mirrors the physical properties that `dir="rtl"` alone\n' +
      '// cannot flip. Inert on a left-to-right site.\n' +
      '@use "../../styles/op-rtl.scss";',
  },
]

/**
 * Apply all three to a Quartz checkout, or explain which one no longer fits.
 *
 * Safe to run twice, which matters: `build-site.mjs` reuses a checkout between
 * builds, so the second build finds one that is already patched. That is not
 * the same failure as a line that moved. The first is "nothing to do", the
 * second is "this repository no longer understands Quartz", and only the second
 * throws.
 *
 * "Already patched" is answered by looking for the *result*, before counting
 * the anchor, because one anchor survives its own replacement: the stylesheet
 * patch keeps `@use "./callouts.scss";` and adds a line after it. Counting
 * first found its anchor still there, applied the patch again, and Sass
 * rejected the duplicate import. Which is the whole argument for this function
 * being one place rather than three.
 */
export async function patchDirection(root) {
  for (const { file, find, replace } of PATCHES) {
    const path = join(root, ...file)
    const source = await readFile(path, 'utf8')
    if (source.includes(replace)) continue
    const count = source.split(find).length - 1
    if (count !== 1) {
      throw new Error(
        `Cannot patch ${file.join('/')}: expected exactly one occurrence of\n` +
          `  ${find.split('\n')[0]}\n` +
          `but found ${count}. Quartz has moved this line. Update scripts/lib/rtl-patch.mjs\n` +
          'to match its new shape, or right-to-left sites will silently render left to right.',
      )
    }
    await writeFile(path, source.replace(find, replace))
  }
}
