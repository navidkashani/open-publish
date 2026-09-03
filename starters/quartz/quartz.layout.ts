import { PageLayout, SharedLayout } from './quartz/cfg'
import * as Component from './quartz/components'
import { site } from './op-site'
import { navExplorerOptions } from './nav-sort'

/**
 * Layout, driven by the site options set in Obsidian.
 *
 * Each toggle in the plugin's settings maps to a component here. Because the
 * options are part of the snapshot ID, flipping one produces a new snapshot and
 * therefore a rebuild, even when no note changed.
 */

const optional = <T>(enabled: boolean, component: T): T[] => (enabled ? [component] : [])

/**
 * The explorer, arranged if anybody arranged it.
 *
 * Built once and used by both layouts so the two cannot drift apart, and called
 * rather than shared as a value because each layout needs its own component
 * instance. `navExplorerOptions` returns undefined when the snapshot carries no
 * navigation, and `Explorer(undefined)` is the same call as `Explorer()`: a site
 * nobody has arranged renders byte for byte what it always did.
 */
const explorer = () => Component.Explorer(navExplorerOptions(site.nav))

export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [],
  footer: Component.Footer({
    links: {
      'Published with Open Publish': 'https://github.com/navidkashani/open-publish',
    },
  }),
}

/**
 * `ContentMeta` is Quartz's page-metadata block: the reading time and the
 * modified date under the title. `showPageMetadata` off drops it rather than
 * hiding it, so nothing is rendered and then styled away.
 *
 * `showPrevNext` has no component to map onto here: Quartz ships no
 * previous/next control. Ignoring an option a generator cannot express is what
 * `docs/architecture.md` says to do with one, and it stays in the snapshot for
 * the starter that can.
 */
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    ...optional(site.showPageMetadata, Component.ContentMeta()),
    ...optional(site.showTags, Component.TagList()),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    ...optional(site.showSearch, Component.Search()),
    ...optional(site.showThemeToggle, Component.Darkmode()),
    ...optional(site.showGraph, Component.DesktopOnly(Component.Graph())),
    ...optional(site.showNavigation, Component.DesktopOnly(explorer())),
  ],
  right: [
    ...optional(site.showOutline, Component.DesktopOnly(Component.TableOfContents())),
    ...optional(site.showBacklinks, Component.Backlinks()),
  ],
}

export const defaultListPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    ...optional(site.showPageMetadata, Component.ContentMeta()),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    ...optional(site.showSearch, Component.Search()),
    ...optional(site.showThemeToggle, Component.Darkmode()),
    ...optional(site.showNavigation, Component.DesktopOnly(explorer())),
  ],
  right: [],
}
