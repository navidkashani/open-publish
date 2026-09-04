import { QuartzConfig } from './quartz/cfg'
import { TRANSLATIONS } from './quartz/i18n'
import type { ValidLocale } from './quartz/i18n'
import * as Plugin from './quartz/plugins'
import { site } from './op-site'
import { resolveBaseUrl } from './scripts/lib/site-url.mjs'

/**
 * Quartz configuration for an Open Publish site.
 *
 * The `site` import is regenerated on every build from the snapshot, so the
 * toggles in Obsidian's settings take effect without anyone editing this file.
 * Everything else here is yours to change.
 */
/** Map the generator-agnostic analytics option onto what Quartz expects. */
function analyticsConfig() {
  const { provider, id } = site.analytics
  if (!id) return null
  switch (provider) {
    case 'google':
      return { provider: 'google', tagId: id } as const
    case 'plausible':
      return { provider: 'plausible', host: id } as const
    case 'umami':
      return { provider: 'umami', websiteId: id } as const
    default:
      return null
  }
}

const config: QuartzConfig = {
  configuration: {
    pageTitle: site.title,
    enableSPA: true,
    enablePopovers: site.showHoverPreview,
    analytics: analyticsConfig(),
    // Checked against Quartz's own translation table rather than trusted. An
    // unknown tag makes `TRANSLATIONS[locale]` undefined at runtime, and every
    // piece of chrome text on the site becomes `undefined`, so a language
    // Quartz has no strings for has to fall back to one it does.
    locale: (site.locale in TRANSLATIONS ? site.locale : 'en-US') as ValidLocale,
    // Written by the plugin, derived there from the language. Narrowed rather
    // than cast because `op-site.ts` is generated from JSON, so its `dir` is
    // typed as a plain string.
    dir: site.dir === 'rtl' ? 'rtl' : 'ltr',
    // Must be undefined rather than '' when unknown. See scripts/lib/site-url.mjs.
    baseUrl: resolveBaseUrl(),
    ignorePatterns: ['private', 'templates', '.obsidian'],
    defaultDateType: 'created',
    theme: {
      fontOrigin: 'googleFonts',
      cdnCaching: true,
      typography: {
        header: 'Schibsted Grotesk',
        body: 'Source Sans Pro',
        code: 'IBM Plex Mono',
      },
      colors: {
        lightMode: {
          light: '#faf8f8',
          lightgray: '#e5e5e5',
          gray: '#b8b8b8',
          darkgray: '#4e4e4e',
          dark: '#2b2b2b',
          secondary: '#284b63',
          tertiary: '#84a59d',
          highlight: 'rgba(143, 159, 169, 0.15)',
          textHighlight: '#fff23688',
        },
        darkMode: {
          light: '#161618',
          lightgray: '#393639',
          gray: '#646464',
          darkgray: '#d4d4d4',
          dark: '#ebebec',
          secondary: '#7b97aa',
          tertiary: '#84a59d',
          highlight: 'rgba(143, 159, 169, 0.15)',
          textHighlight: '#b3aa0288',
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({ priority: ['frontmatter', 'filesystem'] }),
      Plugin.SyntaxHighlighting({ theme: { light: 'github-light', dark: 'github-dark' }, keepBackground: false }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      // Off means a single newline renders as a line break, which is what most
      // people writing notes expect to see.
      ...(site.strictLineBreaks ? [] : [Plugin.HardLineBreaks()]),
      Plugin.TableOfContents(),
      // Links arrive already resolved by the plugin, so Quartz only has to
      // normalise what is left rather than guess at unresolvable targets.
      Plugin.CrawlLinks({ markdownLinkResolution: 'absolute' }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: 'katex' }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      ...(site.showTags ? [Plugin.TagPage()] : []),
      Plugin.ContentIndex({ enableSiteMap: true, enableRSS: true }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
