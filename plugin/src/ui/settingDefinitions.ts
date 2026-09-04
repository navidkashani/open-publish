/**
 * The settings tree, as data.
 *
 * What this replaced was one flat scroll of roughly 45 rows: seven headings
 * top to bottom, nothing collapsible, and nothing findable. Obsidian's own
 * settings search could not help, because it indexes only what a plugin
 * declares through this API.
 *
 * The rule that makes the module worth extracting is the one `README.md`
 * already states for `core/`: **Obsidian is imported for types only.** Every
 * type below is erased by Node's type stripping, so the whole tree can be
 * asserted as plain data under `node --test` with no mock of Obsidian
 * anywhere. That was previously impossible for anything in `ui/`.
 *
 * Keeping to that has one consequence worth knowing before editing this file:
 * `SettingPage`, `Modal`, `Notice` and `PathSuggest` are runtime **values**, so
 * this module must never construct one. Everything that needs a value arrives
 * through {@link SettingDeps} as a callback the builder only stores. `render`
 * callbacks are safe to hold for the same reason: building the array never
 * invokes them.
 *
 * Two limits of the API shape the file:
 *
 *  - **`desc` cannot be a function.** `visible`, `disabled`, `displayValue`
 *    and `status` can be; a description cannot. So every description that
 *    depends on state is computed here, at build time, and refreshed by
 *    `update()` on the tab. {@link RERENDER_KEYS} names the control keys whose
 *    change needs that.
 *  - **`disabled` exists on `control` and `action` rows, not on `render`
 *    rows.** The one row that wants both a disabled control and an inline
 *    error message ("Customize navigation") is therefore a `render` row that
 *    sets its own button state.
 */

import type { SettingDefinitionItem, SettingGroupItem, SettingPage } from 'obsidian'
import type { AnalyticsProvider, SiteToggleKey } from '../core/snapshot.ts'
import type { Settings } from '../settings.ts'
import { ROLLBACK_HEADLINE, hasHostMoved, hasStorageMoved, isRolledBack, rollbackWarning } from '../settings.ts'
import { providerById } from '../destinations/providers.ts'
import { hostById } from '../builders/hosts.ts'
import { LOCALES, directionFor, isLocale } from '../core/locales.ts'
import { isAlwaysExcluded } from '../core/selection.ts'
import { isUrlStyle } from '../core/slug.ts'
import { folderRulesSentence, folderRulesSummary, summarizeRules } from './FolderRules.ts'

const HOMEPAGE_DESC = 'The note visitors land on, e.g. "Notes/Home.md". It has to be a published note.'
const GENERATED_HOMEPAGE = 'A simple index page will be generated.'

/**
 * The toggles rendered by the loop under "Appearance".
 *
 * The light/dark control and strict line breaks are rendered on their own just
 * above it, because each needs a sentence of explanation the others do not.
 */
type AppearanceKey = Exclude<SiteToggleKey, 'showThemeToggle' | 'strictLineBreaks'>

/**
 * A record keyed by the option names themselves, and `satisfies` rather than an
 * annotation, so a site option added without a control here fails to compile.
 * The list this replaced was a bare union of string literals, unconnected to
 * `SnapshotSite`: a new option could be published with nothing to set it.
 */
const APPEARANCE = {
  showNavigation: { label: 'Navigation', desc: 'A list of published pages alongside the content.' },
  showSearch: { label: 'Search', desc: 'Search across page titles, headings and content.' },
  showGraph: { label: 'Graph view', desc: 'A small local graph on each page.' },
  showOutline: { label: 'Table of contents', desc: 'The outline of headings on each page.' },
  showBacklinks: { label: 'Backlinks', desc: 'Which published pages link to this one.' },
  showTags: { label: 'Tags', desc: "Show a page's tags, and give each tag its own page." },
  showPageMetadata: {
    label: 'Page metadata',
    desc: 'Created and updated dates, and the frontmatter fields the site chooses to show.',
  },
  showPrevNext: {
    label: 'Previous and next links',
    desc: 'Links to the pages either side of this one, at the foot of the page.',
  },
} satisfies Record<AppearanceKey, { label: string; desc: string }>

const APPEARANCE_KEYS = Object.keys(APPEARANCE) as AppearanceKey[]

/** What the Appearance entry counts, so "6 of 10 on" is checkable against the page. */
const APPEARANCE_TOGGLES: SiteToggleKey[] = ['showThemeToggle', 'strictLineBreaks', ...APPEARANCE_KEYS]

const ANALYTICS_LABELS: Record<AnalyticsProvider, string> = {
  none: 'None',
  google: 'Google Analytics',
  plausible: 'Plausible',
  umami: 'Umami',
}

const ANALYTICS_HINTS: Record<AnalyticsProvider, string> = {
  none: 'No analytics are added to your site.',
  google: 'Your Google Analytics measurement ID, e.g. G-XXXXXXXXXX.',
  plausible: 'Your Plausible domain, e.g. notes.example.com.',
  umami: 'Your Umami website ID.',
}

/**
 * Everything the tree needs that this module is not allowed to construct.
 *
 * The dialogs and the note picker are Obsidian values; the vault questions are
 * plain functions so the tree can be built against a list of strings.
 */
export interface SettingDeps {
  settings: Settings
  /** Persist. `control` rows save through `setControlValue`; `render` rows use this. */
  save: () => Promise<void>
  /** Rebuild the tree and repaint, for the descriptions that cannot be functions. */
  update: () => void

  /** The two forms that stay imperative, wrapped in a `SettingPage` by the caller. */
  storagePage: () => SettingPage
  buildPage: () => SettingPage

  /** The ways out to a dialog, each one a `Modal` subclass this module never holds. */
  openSetup: () => void
  openFolders: () => void
  openNavigation: () => void
  openRollback: () => void

  /** What the vault is asked, as plain questions. */
  filePaths: () => string[]
  markdownPaths: () => string[]
  folderExists: (path: string) => boolean
  fileExists: (path: string) => boolean
  isNotePublished: (path: string) => boolean
  /** The `publish:` frontmatter that outranks a per-file choice, or null for none. */
  frontmatterPublish: (path: string) => boolean | null

  /** Obsidian's note suggester and its path normaliser, both runtime values. */
  attachPathSuggest: (
    input: HTMLInputElement,
    options: { items: () => string[]; onPick: (path: string) => void },
  ) => void
  normalizeTypedPath: (typed: string) => string

  /** Lives with the navigation dialog, which imports Obsidian values. */
  navSizeWarning: (entries: number) => string | null

  /** The maintenance jobs, and how a finished one is announced. */
  runSelfTest: () => Promise<void>
  runCleanup: () => Promise<void>
  clearHashCache: () => Promise<void>
  notify: (message: string) => void
}

/**
 * Eight rows, and no heading above them: the tab title already names the
 * plugin, which is Obsidian's own guidance.
 */
export function settingDefinitions(deps: SettingDeps): SettingDefinitionItem[] {
  return [
    setupRow(deps),
    storageEntry(deps),
    buildEntry(deps),
    selectionPage(deps),
    sitePage(deps),
    appearancePage(deps),
    maintenancePage(deps),
    credentialsRow(deps),
  ]
}

// --- the landing rows ------------------------------------------------------

function setupRow(deps: SettingDeps): SettingDefinitionItem {
  return {
    name: 'Setup',
    desc: 'Walks you through storage, the site repository, hosting and the deploy hook, testing each step.',
    aliases: ['wizard', 'getting started', 'first run'],
    render: (setting) => {
      setting.addButton((button) =>
        button
          .setButtonText('Open setup guide')
          .setCta()
          .onClick(() => deps.openSetup()),
      )
    },
  }
}

/**
 * Storage, as one line that names the provider it is set to.
 *
 * The aliases are the price of keeping `StorageFields` imperative: the rows
 * inside a `page()` factory are not indexed, so the words somebody would
 * actually search for are declared here instead. Converting the form to
 * declarative rows would index each one, and is deliberately a separate
 * change: it touches the code path the setup wizard shares.
 */
function storageEntry(deps: SettingDeps): SettingDefinitionItem {
  const { settings } = deps
  return {
    type: 'page',
    name: 'Storage',
    desc: 'Where your published notes are uploaded.',
    displayValue: () => storageSummary(settings),
    status: () => (hasStorageMoved(settings) ? 'warning' : null),
    aliases: [
      'bucket',
      'endpoint',
      'region',
      'access key',
      'secret',
      'key prefix',
      'R2',
      'S3',
      'path-style',
      'test connection',
      'account ID',
      'Worker address',
      'token',
    ],
    page: () => deps.storagePage(),
  }
}

/** The provider's own name, plus the prefix when there is one to say. */
export function storageSummary(settings: Settings): string {
  const name = providerById(settings.destination.provider).name
  const prefix = settings.destination.prefix
  return prefix ? `${name} · ${prefix}` : name
}

function buildEntry(deps: SettingDeps): SettingDefinitionItem {
  const { settings } = deps
  return {
    type: 'page',
    name: 'Site build',
    desc: 'The host that builds your site and serves it.',
    displayValue: () => hostById(settings.builder.host).name,
    status: () => (hasHostMoved(settings) ? 'warning' : null),
    aliases: [
      'deploy hook',
      'webhook',
      'host',
      'hosting',
      'Cloudflare Pages',
      'Netlify',
      'Vercel',
      'site URL',
      'build logs',
      'starter',
      'request method',
    ],
    page: () => deps.buildPage(),
  }
}

/**
 * The credentials note, as a row rather than as a bare paragraph under a
 * heading. The same fact either way, in the terms of whatever is actually
 * stored: saying "these keys" to somebody who has none reads as boilerplate,
 * and boilerplate is what people stop reading.
 *
 * What survived the move into Obsidian's keychain is the sentence that matters
 * most and the one a plugin can do least about. The keychain is one namespace
 * on the same `app` object every plugin is handed, and `getSecret` is public
 * API. It is out of your vault; it is not private.
 */
function credentialsRow(deps: SettingDeps): SettingDefinitionItem {
  return {
    name: 'About your credentials',
    desc:
      deps.settings.destination.type === 'gateway'
        ? "This token is kept in Obsidian's keychain rather than in your vault, so it does not travel with your " +
          'notes. Any other plugin you install can still read it. This is not encryption you control, and nothing ' +
          'can make it so. What it changes is reach: the token gets to your Worker, which gets to one bucket, and ' +
          'you can replace it with one command.'
        : "These keys are kept in Obsidian's keychain rather than in your vault, so they do not travel with your " +
          'notes. Any other plugin you install can still read them. Use a token that can only reach this one ' +
          'bucket, and revoke it in a click if you need to.',
    aliases: ['keychain', 'security', 'privacy'],
  }
}

// --- what gets published ---------------------------------------------------

function selectionPage(deps: SettingDeps): SettingDefinitionItem {
  const selection = deps.settings.selection

  // One row rather than two textareas. The counts are the point: a folder rule
  // is worth showing as what it currently matches, not as text.
  const summary = summarizeRules({
    files: deps.filePaths(),
    includes: selection.includes,
    excludes: selection.excludes,
    folderExists: deps.folderExists,
  })

  const paths = Object.keys(selection.explicit).sort()

  return {
    type: 'page',
    name: 'What gets published',
    desc: 'Folder rules, embedded attachments, and the notes you have chosen one at a time.',
    displayValue: () => folderRulesSentence(summary),
    aliases: ['folders', 'include', 'exclude', 'attachments', 'embeds', 'per-file', 'rules'],
    items: [
      {
        name: 'Folders',
        desc: folderRulesSummary(summary),
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText('Manage folders…')
              // Rebuilding the tree is what refreshes the counts and revalidates
              // the homepage, which a rule change can invalidate.
              .onClick(() => deps.openFolders()),
          )
        },
      },
      {
        name: 'Include embedded attachments automatically',
        desc:
          'Publishes any image or file that a published note embeds, wherever it lives in your vault. ' +
          'Turning this off is the usual cause of a site with broken images.',
        control: { type: 'toggle', key: 'selection.autoIncludeEmbeds' },
      },
      /*
       * The per-file choices, as a list rather than a count.
       *
       * These are written by the file context menu and by "Add linked" in the
       * publish window, so they accumulate without anyone deciding to keep a
       * list. That is what makes "3 files" the least useful thing to say about
       * them.
       *
       * `emptyState` is what the heading used to have to carry itself:
       * publishing a single note is a real route and the only one with no
       * control anywhere on screen, so the empty state is where it gets said.
       */
      {
        type: 'list',
        heading: 'Per-file choices',
        emptyState:
          'None yet. Right click any note and choose "Publish with Open Publish" to publish it on its own, ' +
          'wherever it lives.',
        onDelete: (index) => {
          const path = paths[index]
          if (path === undefined) return
          delete selection.explicit[path]
          void deps.save()
          deps.update()
        },
        items: paths.map((path) => ({
          name: path,
          desc: explicitDesc(deps, path),
        })),
      },
      {
        name: 'Forget every per-file choice',
        desc: 'Folder rules and frontmatter are untouched.',
        visible: () => paths.length > 0,
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText('Clear all')
              .setDestructive()
              .onClick(() => {
                selection.explicit = {}
                void deps.save()
                deps.update()
              }),
          )
        },
      },
    ],
  }
}

/**
 * What one per-file choice currently does, including the case where it does
 * nothing: frontmatter outranks the stored preference, so a note that pins its
 * own state makes the row inert. Better to say so than to leave somebody
 * wondering why the choice has no effect.
 */
function explicitDesc(deps: SettingDeps, path: string): string {
  const state = deps.settings.selection.explicit[path] ? 'Published on its own.' : 'Excluded on its own.'
  const pinned = deps.frontmatterPublish(path)
  if (pinned === null) return state
  return `${state} This note sets publish: ${pinned} in its frontmatter, which wins. This choice has no effect.`
}

// --- site options ----------------------------------------------------------

function sitePage(deps: SettingDeps): SettingDefinitionItem {
  const site = deps.settings.site

  return {
    type: 'page',
    name: 'Site options',
    desc: 'What the site is called, what language it is in, and what it does with addresses.',
    displayValue: () => site.title,
    aliases: ['title', 'name', 'language', 'locale', 'homepage', 'index', 'URLs', 'redirects', 'noindex'],
    items: [
      {
        name: 'Site name',
        desc: 'Shown in the page title and in the site header.',
        control: { type: 'text', key: 'site.title' },
      },
      {
        name: 'Language',
        desc:
          'The language your notes are written in. It sets the language of the site chrome: the ' +
          'search box, the backlinks heading, the dates. It also tells browsers and search engines ' +
          'what they are reading. Arabic and Persian also lay the site out right to left.',
        control: {
          type: 'dropdown',
          key: 'site.locale',
          options: Object.fromEntries(LOCALES.map((locale) => [locale.tag, locale.label])),
        },
      },
      homepageRow(deps),
      urlStyleRow(),
      {
        name: 'Discourage search engines',
        desc:
          'Asks search engines not to list your site. ' +
          'It is a request, not a lock: anyone with the address can still read everything.',
        control: { type: 'toggle', key: 'site.noIndex' },
      },
      {
        type: 'group',
        heading: 'Analytics',
        items: [
          {
            name: 'Provider',
            desc: 'Check your local laws before enabling analytics.',
            control: { type: 'dropdown', key: 'site.analytics.provider', options: ANALYTICS_LABELS },
          },
          // Declaration order is render order, which is what retired the
          // `insertAdjacentElement` move that used to put this row above the
          // dropdown that governs it.
          {
            name: 'Tracking ID',
            desc: ANALYTICS_HINTS[site.analytics.provider],
            visible: () => site.analytics.provider !== 'none',
            control: { type: 'text', key: 'site.analytics.id' },
          },
        ],
      },
    ],
  }
}

/**
 * The homepage, as a note picker with the check done here rather than later.
 *
 * All three failure states used to surface at scan time, as a warning inside
 * the publish window, which is the wrong place and the wrong moment for
 * something you can only fix in settings.
 *
 * It stays a `render` row rather than becoming `control: { type: 'file' }`:
 * that control validates a candidate before persisting it, and two of the
 * three states here are about a value that is already stored and still worth
 * saying out loud.
 */
function homepageRow(deps: SettingDeps): SettingGroupItem {
  const site = deps.settings.site

  return {
    name: 'Homepage',
    desc: site.homepage ? HOMEPAGE_DESC : GENERATED_HOMEPAGE,
    aliases: ['index', 'landing page', 'front page'],
    render: (setting) => {
      const validate = (): void => {
        const path = site.homepage
        if (!path) {
          setting.setDesc(GENERATED_HOMEPAGE)
          setting.setErrorMessage(null)
          return
        }
        setting.setDesc(HOMEPAGE_DESC)
        if (!deps.fileExists(path)) {
          setting.setErrorMessage('This note no longer exists.')
          return
        }
        setting.setErrorMessage(
          deps.isNotePublished(path)
            ? null
            : "This note isn't being published, so the site will use a generated index page instead.",
        )
      }

      setting.addSearch((search) => {
        search.setPlaceholder('Notes/Home.md').setValue(site.homepage)

        const apply = async (value: string): Promise<void> => {
          site.homepage = deps.normalizeTypedPath(value)
          await deps.save()
          validate()
        }

        deps.attachPathSuggest(search.inputEl, {
          items: () => deps.markdownPaths().filter((path) => !isAlwaysExcluded(path)),
          onPick: (path) => void apply(path),
        })

        search.onChange((value) => void apply(value))
      })

      validate()
    },
  }
}

/**
 * Whether old Obsidian Publish URLs keep working.
 *
 * The description carries the one condition that decides whether this is worth
 * anything, because the setting cannot check it: the redirects are pages on
 * *this* site, so they only meet a visitor who arrives at the domain this site
 * is served on. Somebody whose notes lived on `publish.obsidian.md/username`
 * is moving to an address they did not have before, and nothing they host can
 * catch a link to one they never owned.
 */
function urlStyleRow(): SettingGroupItem {
  return {
    name: 'Site URLs',
    desc:
      'Pages always live at clean, lowercase addresses. If you are moving from Obsidian Publish and keeping ' +
      'the domain it was served on, the second option also puts a redirect at every URL Obsidian used, so ' +
      'existing links and search results still arrive. It cannot help with links to publish.obsidian.md.',
    control: {
      type: 'dropdown',
      key: 'urlStyle',
      options: { clean: 'Clean', 'clean-with-redirects': 'Clean, keep my old links working' },
    },
  }
}

// --- appearance ------------------------------------------------------------

function appearancePage(deps: SettingDeps): SettingDefinitionItem {
  const site = deps.settings.site
  const items: SettingGroupItem[] = [
    {
      name: 'Light/dark toggle',
      desc: 'Let visitors switch theme. The site follows their system setting either way.',
      control: { type: 'toggle', key: 'site.showThemeToggle' },
    },
    {
      name: 'Strict line breaks',
      desc:
        'Markdown ignores single line breaks. Leave this off and they show up as you wrote them, ' +
        'which is usually what you want for notes.',
      control: { type: 'toggle', key: 'site.strictLineBreaks' },
    },
  ]

  for (const key of APPEARANCE_KEYS) {
    const { label, desc } = APPEARANCE[key]
    items.push({ name: label, desc, control: { type: 'toggle', key: `site.${key}` } })
    // Directly under the toggle it depends on, rather than in a section of its
    // own: an arrangement of a sidebar that is switched off is a control with
    // nothing to control, and the two belong next to each other.
    if (key === 'showNavigation') items.push(navigationRow(deps))
  }

  return {
    type: 'page',
    name: 'Appearance',
    desc: 'What a page on your site shows around the content.',
    displayValue: () => `${APPEARANCE_TOGGLES.filter((key) => site[key]).length} of ${APPEARANCE_TOGGLES.length} on`,
    aliases: ['theme', 'dark mode', 'line breaks', ...APPEARANCE_KEYS.map((key) => APPEARANCE[key].label)],
    items,
  }
}

/**
 * The way into the navigation manager, and a one-line report of what it has
 * been told so far.
 *
 * The summary is here rather than only inside the dialog for the reason the
 * folder-rule counts are: a setting that says nothing about its current state
 * is one people open to find out, and this one is off the main path.
 *
 * A `render` row rather than an `action` row with a declarative `disabled`,
 * because the size warning below is a `Setting.setErrorMessage` and there is
 * no declarative equivalent. The description changes with the toggle above it
 * either way, and a description cannot be a function, so the toggle rebuilds
 * the tree rather than only refreshing DOM state. See {@link RERENDER_KEYS}.
 */
function navigationRow(deps: SettingDeps): SettingGroupItem {
  const site = deps.settings.site
  const nav = site.nav ?? { order: [], hidden: [] }

  const describe = (): string => {
    if (!site.showNavigation) return 'Turn navigation on to arrange it.'
    if (nav.order.length === 0 && nav.hidden.length === 0) {
      return 'Folders first, then notes, alphabetically. Change the order, or leave pages out of it.'
    }
    const parts: string[] = []
    if (nav.order.length > 0) parts.push(`${nav.order.length} arranged by hand`)
    if (nav.hidden.length > 0) parts.push(`${nav.hidden.length} hidden`)
    return `${parts.join(', ')}. Hidden pages are still published and still reachable.`
  }

  return {
    name: 'Customize navigation',
    desc: describe(),
    aliases: ['sidebar', 'order', 'hidden pages', 'arrange'],
    render: (setting) => {
      setting.setErrorMessage(deps.navSizeWarning(nav.order.length))
      setting.addButton((button) =>
        button
          .setButtonText('Manage')
          .setDisabled(!site.showNavigation)
          .onClick(() => deps.openNavigation()),
      )
    },
  }
}

// --- maintenance -----------------------------------------------------------

function maintenancePage(deps: SettingDeps): SettingDefinitionItem {
  const { settings } = deps
  const cleanupCaution = providerById(settings.destination.provider).caution

  return {
    type: 'page',
    name: 'Maintenance',
    desc: 'Publish history, and the jobs that check or tidy your storage.',
    displayValue: () =>
      settings.lastPublishedAt
        ? new Date(settings.lastPublishedAt).toLocaleDateString()
        : 'Nothing published yet',
    status: () => (isRolledBack(settings) ? 'warning' : null),
    aliases: ['rollback', 'history', 'versions', 'self-test', 'clean up', 'orphans', 'cache', 're-check'],
    items: [
      // First, and above the rows it is about, so the explanation arrives
      // before the control. Not in Storage, where `hasStorageMoved`'s warning
      // lives: that one is about where the bucket is, and this one is about
      // publish history, which is what this page is for.
      {
        name: ROLLBACK_HEADLINE,
        desc: rollbackWarning(settings) ?? '',
        visible: () => isRolledBack(settings),
        render: (setting) => {
          setting.settingEl.addClass('op-notice-warning')
          setting.settingEl.addClass('op-rolled-back')
        },
      },
      {
        name: 'Last publish',
        desc: lastPublishDesc(settings),
      },
      {
        name: 'Site history',
        desc: 'Make an earlier version of your site live again.',
        render: (setting) => {
          setting.addButton((button) =>
            button
              .setButtonText('Browse')
              // Rebuild afterwards: a rollback raises the panel above and a
              // roll forward clears it, and neither is visible from here.
              .onClick(() => deps.openRollback()),
          )
        },
      },
      {
        name: 'Storage self-test',
        desc:
          'Checks that your storage can do everything publishing needs. ' +
          'Only writes test files, and deletes them after.',
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText('Run self-test').onClick(async () => {
              button.setButtonText('Running…').setDisabled(true)
              await deps.runSelfTest()
              button.setButtonText('Run self-test').setDisabled(false)
            }),
          )
        },
      },
      {
        name: 'Clean up unused files',
        // Wasabi bills a deleted object for the rest of its 90 days, so on that
        // one provider this button costs money rather than saving it. The
        // warning belongs here as much as in the picker: this is where it is
        // spent.
        desc:
          'Deletes files in your storage that your site no longer uses. ' +
          'Keeps the last 5 publishes and anything from the past week. It will not run while a publish is going.' +
          (cleanupCaution ? ` ${cleanupCaution}` : ''),
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText('Clean up').onClick(async () => {
              button.setButtonText('Checking…').setDisabled(true)
              await deps.runCleanup()
              button.setButtonText('Clean up').setDisabled(false)
            }),
          )
        },
      },
      {
        name: 'Re-check every file',
        desc: 'Makes the next scan check every file from scratch. Safe. It only makes that one scan slower.',
        render: (setting) => {
          setting.addButton((button) =>
            button.setButtonText('Clear').onClick(async () => {
              await deps.clearHashCache()
              deps.notify('Every file will be checked on the next scan.')
            }),
          )
        },
      },
    ],
  }
}

/**
 * The version is named only when it is still the one that publish produced.
 *
 * A rollback moves `lastSnapshotId` and leaves `lastPublishedAt` where it was,
 * which is correct for both fields and a lie when read as one sentence: it
 * would date a publish that never happened. The panel above says which version
 * is live, so this drops back to the plain fact.
 */
function lastPublishDesc(settings: Settings): string {
  const at = settings.lastPublishedAt
  if (!at) return 'Nothing has been published from this device yet.'
  const when = new Date(at).toLocaleString()
  if (isRolledBack(settings)) return when
  return `${when} (version ${settings.lastSnapshotId ?? 'unknown'})`
}

// --- control keys ----------------------------------------------------------

/**
 * The control keys whose change needs the tree rebuilt rather than only its
 * DOM state refreshed, because something's **description** depends on them and
 * a description cannot be a function.
 *
 *  - `site.analytics.provider` decides the Tracking ID hint.
 *  - `site.showNavigation` decides what the Customize navigation row says, and
 *    whether its button is live.
 */
export const RERENDER_KEYS: ReadonlySet<string> = new Set(['site.analytics.provider', 'site.showNavigation'])

/** Dot-notation read against the nested `Settings` shape. */
export function readSetting(settings: Settings, key: string): unknown {
  let node: unknown = settings
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

/**
 * Dot-notation write, with the four keys that are not a plain assignment.
 *
 * Each of them is a value the rest of the plugin reads as a union, and a
 * dropdown hands back a bare string, so the guard is what stops a future option
 * name reaching `data.json` unvalidated.
 */
export function writeSetting(settings: Settings, key: string, value: unknown): void {
  switch (key) {
    case 'site.locale': {
      if (!isLocale(value)) return
      settings.site.locale = value
      // Written together, always, so settings can never hold a direction that
      // disagrees with its language. `migrateSettings` re-derives it on load
      // for the same reason.
      settings.site.dir = directionFor(value)
      return
    }
    case 'urlStyle': {
      settings.urlStyle = isUrlStyle(value) ? value : 'clean'
      return
    }
    case 'site.analytics.provider': {
      if (isAnalyticsProvider(value)) settings.site.analytics.provider = value
      return
    }
    case 'site.analytics.id': {
      settings.site.analytics.id = String(value).trim()
      return
    }
    default: {
      const parts = key.split('.')
      const last = parts.pop()
      if (last === undefined) return
      let node: Record<string, unknown> = settings as unknown as Record<string, unknown>
      for (const part of parts) {
        const next = node[part]
        if (typeof next !== 'object' || next === null) return
        node = next as Record<string, unknown>
      }
      node[last] = value
    }
  }
}

function isAnalyticsProvider(value: unknown): value is AnalyticsProvider {
  return typeof value === 'string' && Object.hasOwn(ANALYTICS_LABELS, value)
}
