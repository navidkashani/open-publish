/** Redirects `obsidian` imports to the stub, then hands back the UI modules. */
import { registerHooks } from 'node:module'
import { PublishSession } from '../src/core/session.ts'

const stub = new URL('./obsidian-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'obsidian') return { url: stub, shortCircuit: true }
    return next(specifier, context)
  },
})

export const { PublishModal } = await import('../src/ui/PublishModal.ts')
export const { StatusBar } = await import('../src/ui/StatusBar.ts')
export const { Platform } = await import('./obsidian-stub.mjs')
export { notices, MODAL_MEMBERS } from './obsidian-stub.mjs'
export { PublishSession }

/** A stand-in for the plugin: records what the window asked it to do. */
export function fakePlugin(overrides = {}) {
  const calls = { publishes: [], settings: 0, setup: 0, updates: 0, windowOpen: [] }
  const plugin = {
    calls,
    settings: {
      builder: { siteUrl: 'https://example.test', logsUrl: 'https://logs.test', url: 'https://hook.test' },
      selection: { explicit: {} },
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
