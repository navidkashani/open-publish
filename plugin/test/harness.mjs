/** Redirects `obsidian` imports to the stub, then hands back the UI modules. */
import { registerHooks } from 'node:module'
import { PublishSession } from '../src/core/session.ts'
import { migrateSettings } from '../src/settings.ts'

const stub = new URL('./obsidian-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'obsidian') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})

/**
 * The scan, which imports `TFile` as a value and so cannot be loaded without
 * the stub in place. Everything else in `core/` imports Obsidian types only.
 */
export const { scanVault } = await import('../src/core/scanner.ts')
export const { PublishModal } = await import('../src/ui/PublishModal.ts')
export const { StatusBar } = await import('../src/ui/StatusBar.ts')
export const { FolderModal } = await import('../src/ui/FolderModal.ts')
export const { NavigationModal, navSizeWarning } = await import('../src/ui/NavigationModal.ts')
export const { PublishImportModal, renderPublishImportRow } = await import('../src/ui/PublishImportModal.ts')
export const { RollbackModal } = await import('../src/ui/RollbackModal.ts')
export const { OpenPublishSettingTab } = await import('../src/ui/SettingsTab.ts')
export const { SetupWizard } = await import('../src/ui/SetupWizard.ts')
/**
 * The plugin class itself, which is loadable here for one reason: every
 * `obsidian` import below it resolves to the stub. It is imported for the
 * destination boundary in `main.ts`, which is the only place a stored secret
 * name becomes a credential and so the only place that can be tested for it.
 */
export const { default: OpenPublishPlugin } = await import('../src/main.ts')
export const { Platform, TFile, TFolder } = await import('./obsidian-stub.mjs')
export { notices, menus, modals, suggesters, secretFields, MODAL_MEMBERS } from './obsidian-stub.mjs'
export { PublishSession }

/**
 * A vault, as much of one as the settings surface asks for: a list of file
 * paths, a list of folder paths, and whatever frontmatter matters.
 */
export function fakeApp({
  folders = [],
  files = [],
  frontmatter = {},
  secrets = {},
  configDir = '.obsidian',
  /**
   * Files under the config directory, which the vault API does not list and the
   * adapter does. A separate map from `files` on purpose: folding them together
   * would confuse them with what `getFiles()` returns, and nothing under the
   * config directory is ever publishable.
   */
  configFiles = {},
} = {}) {
  const folderSet = new Set(folders)
  const fileSet = new Set(files)
  return {
    /**
     * Obsidian's keychain, which is where the two real credentials live now.
     *
     * Device-local in the app and device-local here: a test that wants the
     * second-device case builds an app with no secrets and the same settings.
     */
    secretStorage: {
      getSecret: (id) => (Object.hasOwn(secrets, id) ? secrets[id] : null),
      setSecret: (id, value) => {
        secrets[id] = value
      },
      listSecrets: () => Object.keys(secrets),
    },
    vault: {
      /** Overridable, because following a moved config directory is the point of using it. */
      configDir,
      adapter: {
        exists: async (path) => Object.hasOwn(configFiles, path),
        read: async (path) => {
          if (!Object.hasOwn(configFiles, path)) throw new Error(`ENOENT: ${path}`)
          return configFiles[path]
        },
        write: async (path, data) => {
          configFiles[path] = data
        },
      },
      getFiles: () => files.map((path) => new TFile(path)),
      getMarkdownFiles: () => files.filter((path) => path.endsWith('.md')).map((path) => new TFile(path)),
      getAllFolders: (includeRoot = false) =>
        (includeRoot ? ['/', ...folders] : folders).map((path) => new TFolder(path)),
      getFolderByPath: (path) => (folderSet.has(path) ? new TFolder(path) : null),
      getFileByPath: (path) => (fileSet.has(path) ? new TFile(path) : null),
    },
    metadataCache: {
      getCache: (path) => (frontmatter[path] ? { frontmatter: frontmatter[path] } : null),
    },
  }
}

/**
 * A plugin whose only job here is to hold settings and count saves.
 *
 * `publishConfig` is the text of `<config dir>/publish.json`, or null for a
 * vault that never used Obsidian Publish. It stands in for the pair of methods
 * `main.ts` exposes: one cached boolean, and a fresh read per press.
 */
export function fakeSettingsPlugin(selection = {}, site = {}, extra = {}) {
  const { publishConfig = null, urlStyle = 'clean', lastPublishedAt = null } = extra
  const plugin = {
    saves: 0,
    settings: {
      selection: { includes: [], excludes: [], explicit: {}, autoIncludeEmbeds: true, ...selection },
      site: { title: 'Notes', homepage: '', ...site },
      urlStyle,
      lastPublishedAt,
    },
    hasObsidianPublishConfig: () => publishConfig !== null,
    readObsidianPublishConfig: async () => publishConfig,
    async saveSettings() {
      plugin.saves++
    },
  }
  return plugin
}

/** A stand-in for the plugin: records what the window asked it to do. */
export function fakePlugin(overrides = {}) {
  const calls = { publishes: [], settings: 0, setup: 0, updates: 0, windowOpen: [] }
  const plugin = {
    calls,
    settings: {
      builder: { siteUrl: 'https://example.test', logsUrl: 'https://logs.test', url: 'https://hook.test' },
      selection: { includes: [], excludes: [], explicit: {} },
      ...overrides.settings,
    },
    session: null,
    scan: overrides.scan ?? (async () => { throw new Error('no scan configured') }),
    activeSession: () => plugin.session,
    startPublish(scan, selection, summary) {
      calls.publishes.push({ scan, selection, summary })
      const session =
        overrides.makeSession?.(scan, selection, summary) ??
        new PublishSession({ summary, run: () => new Promise(() => {}) })
      plugin.session = session
      return session
    },
    openSettings: () => calls.settings++,
    openSetup: () => calls.setup++,
    // The publish window opens Manage folders, which offers the Publish import.
    hasObsidianPublishConfig: () => overrides.publishConfig != null,
    readObsidianPublishConfig: async () => overrides.publishConfig ?? null,
    triggerBuildOnly: async () => calls.updates++,
    saveSettings: async () => {},
    setPublishWindowOpen: (open) => calls.windowOpen.push(open),
  }
  return plugin
}

/**
 * A plugin complete enough to render the settings tab and the setup wizard.
 *
 * The settings come from the real `migrateSettings`, so a test can hand over
 * the same shape a `data.json` has and get whatever the shipping migration
 * would have produced, defaults included.
 */
export function fakeStoragePlugin({
  stored = {},
  testResult = { ok: true },
  publishConfig = null,
  /** Which notes count as published, for the screens that list them. */
  isNotePublished = () => true,
} = {}) {
  const calls = { saves: 0, tests: 0, selfTests: 0, cleanups: 0, cacheClears: 0, builderChecks: 0 }
  const plugin = {
    calls,
    settings: migrateSettings(stored),
    manifest: { version: '0.1.0' },
    hasObsidianPublishConfig: () => publishConfig !== null,
    readObsidianPublishConfig: async () => publishConfig,
    async saveSettings() {
      calls.saves++
    },
    async testDestination() {
      calls.tests++
      return testResult
    },
    async testBuilder() {
      calls.builderChecks++
      return { ok: true, reason: 'Site is reachable.' }
    },
    async runStorageSelfTest() {
      calls.selfTests++
    },
    async runGarbageCollection() {
      calls.cleanups++
    },
    async clearHashCache() {
      calls.cacheClears++
    },
    isNotePublished,
  }
  return plugin
}
