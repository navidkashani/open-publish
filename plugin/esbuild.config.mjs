import esbuild from 'esbuild'
import process from 'node:process'
import builtins from 'builtin-modules'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const banner = `/*
Open Publish - bundled by esbuild. Source: https://github.com/navidkashani/open-publish
*/`

const production = process.argv[2] === 'production'

// The manifest lives at the repository root, because that is where the Obsidian
// community directory reads it from: it processes manifest.json at the HEAD of
// the default branch. A vault needs a copy beside main.js, so the build makes
// one, and that copy is an artefact like main.js is: generated, gitignored,
// never hand-edited. Two hand-maintained manifests would drift, and this project
// has already paid for that lesson once with the starter template.
//
// Resolved against this file rather than the working directory, because it is
// the one path here that crosses a directory boundary.
const HERE = dirname(fileURLToPath(import.meta.url))
await copyFile(join(HERE, '..', 'manifest.json'), join(HERE, 'manifest.json'))

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  // `obsidian` and Electron internals are provided by the host at runtime.
  // Node builtins are listed as external so that an accidental import fails
  // loudly at build time on mobile rather than silently bundling a shim.
  external: ['obsidian', 'electron', ...builtins],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  minify: production,
  outfile: 'main.js',
})

if (production) {
  await context.rebuild()
  process.exit(0)
} else {
  await context.watch()
}
