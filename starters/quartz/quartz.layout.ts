import { PageLayout, SharedLayout } from './quartz/cfg'
import * as Component from './quartz/components'
import { site } from './op-site'

/**
 * Layout, driven by the site options set in Obsidian.
 *
 * Each toggle in the plugin's settings maps to a component here. Because the
 * options are part of the snapshot ID, flipping one produces a new snapshot and
 * therefore a rebuild, even when no note changed.
 */

const optional = <T>(enabled: boolean, component: T): T[] => (enabled ? [component] : [])

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

export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.Breadcrumbs(),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    ...optional(site.showTags, Component.TagList()),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    ...optional(site.showSearch, Component.Search()),
    ...optional(site.showThemeToggle, Component.Darkmode()),
    ...optional(site.showGraph, Component.DesktopOnly(Component.Graph())),
    ...optional(site.showNavigation, Component.DesktopOnly(Component.Explorer())),
  ],
  right: [
    ...optional(site.showOutline, Component.DesktopOnly(Component.TableOfContents())),
    ...optional(site.showBacklinks, Component.Backlinks()),
  ],
}

export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    ...optional(site.showSearch, Component.Search()),
    ...optional(site.showThemeToggle, Component.Darkmode()),
    ...optional(site.showNavigation, Component.DesktopOnly(Component.Explorer())),
  ],
  right: [],
}
