import esbuild from 'esbuild'
import process from 'node:process'
import builtins from 'builtin-modules'

const banner = `/*
Open Publish - bundled by esbuild. Source: https://github.com/open-publish/open-publish
*/`

const production = process.argv[2] === 'production'

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
