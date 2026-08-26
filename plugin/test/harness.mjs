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

export const { PublishModal } = await import('../src/ui/PublishModal.ts')
export const { StatusBar } = await import('../src/ui/StatusBar.ts')
export const { FolderModal } = await import('../src/ui/FolderModal.ts')
export const { OpenPublishSettingTab } = await import('../src/ui/SettingsTab.ts')
export const { SetupWizard } = await import('../src/ui/SetupWizard.ts')
export const { Platform, TFile, TFolder } = await import('./obsidian-stub.mjs')
export { notices, menus, modals, suggesters, MODAL_MEMBERS } from './obsidian-stub.mjs'
export { PublishSession }

/**
 * A vault, as much of one as the settings surface asks for: a list of file
 * paths, a list of folder paths, and whatever frontmatter matters.
 */
export function fakeApp({ folders = [], files = [], frontmatter = {} } = {}) {
  const folderSet = new Set(folders)
  const fileSet = new Set(files)
  return {
    vault: {
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

/** A plugin whose only job here is to hold settings and count saves. */
export function fakeSettingsPlugin(selection = {}, site = {}) {
  const plugin = {
    saves: 0,
    settings: {
      selection: { includes: [], excludes: [], explicit: {}, autoIncludeEmbeds: true, ...selection },
      site: { title: 'Notes', homepage: '', ...site },
    },
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
export function fakeStoragePlugin({ stored = {}, testResult = { ok: true } } = {}) {
  const calls = { saves: 0, tests: 0, selfTests: 0, cleanups: 0, cacheClears: 0, builderChecks: 0 }
  const plugin = {
    calls,
    settings: migrateSettings(stored),
    manifest: { version: '0.1.0' },
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
    isNotePublished: () => true,
  }
  return plugin
}
