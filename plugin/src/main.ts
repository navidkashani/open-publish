import { Notice, Plugin, TFile, normalizePath } from 'obsidian'
import {
  DEFAULT_SETTINGS,
  storageMovedWarning,
  hasStorageMoved,
  isDestinationConfigured,
  isHookConfigured,
  migrateSettings,
  recordPublish,
} from './settings.ts'
import type { Settings } from './settings.ts'
import { S3Destination } from './destinations/s3.ts'
import { GatewayDestination } from './destinations/gateway.ts'
import { obsidianHttp } from './destinations/obsidian-http.ts'
import type { Destination, TestResult } from './destinations/types.ts'
import { WebhookBuilder } from './builders/webhook.ts'
import type { Builder, BuilderTestResult } from './builders/types.ts'
import { Hasher } from './core/hasher.ts'
import type { HashCache } from './core/hasher.ts'
import { scanVault } from './core/scanner.ts'
import type { ScanResult } from './core/scanner.ts'
import { Publisher } from './core/publisher.ts'
import type { PublishSelection } from './core/publisher.ts'
import { PublishSession } from './core/session.ts'
import type { PublishSummary, SessionStatus } from './core/session.ts'
import { PublishError, toPublishError } from './core/errors.ts'
import { getPublishFlag, isSupportedFile, parsePublishFrontmatter } from './core/selection.ts'
import { describeGcPlan, planGc, runGc } from './core/gc.ts'
import { runSelfTest } from './core/selftest.ts'
import { PublishModal } from './ui/PublishModal.ts'
import { OpenPublishSettingTab } from './ui/SettingsTab.ts'
import { SetupWizard } from './ui/SetupWizard.ts'
import { StatusBar } from './ui/StatusBar.ts'
import { publishMessage, stateForSession } from './ui/messages.ts'

const CACHE_FILE = 'cache.json'

export default class OpenPublishPlugin extends Plugin {
  override settings: Settings = DEFAULT_SETTINGS
  private hashCache: HashCache = {}
  private hasher: Hasher | null = null
  private readonly publisher = new Publisher()
  private http = obsidianHttp()
  /**
   * The run in progress, if any. It lives here rather than on the modal so that
   * closing the publish window cannot cancel a publish, and so that reopening
   * it attaches to the run instead of rescanning.
   */
  private session: PublishSession | null = null
  private statusBar: StatusBar | null = null
  /** Whether the publish window is showing. Decides who announces the result. */
  private windowOpen = false

  override async onload(): Promise<void> {
    await this.loadSettings()
    await this.loadHashCache()
    this.hasher = new Hasher(this.app, this.hashCache)

    this.addSettingTab(new OpenPublishSettingTab(this.app, this))
    this.statusBar = new StatusBar(this, () => this.openPublishModal())

    this.addRibbonIcon('upload-cloud', 'Publish', () => this.openPublishModal())

    this.addCommand({
      id: 'publish',
      name: 'Publish',
      callback: () => this.openPublishModal(),
    })
    this.addCommand({
      id: 'toggle-current-note',
      name: 'Publish or unpublish the current note',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension !== 'md') return false
        if (!checking) void this.toggleNote(file)
        return true
      },
    })

    // Folder rules cover the common case, but there has to be a way to publish
    // one particular note without inventing a rule for it.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || !isSupportedFile(file.path)) return
        const publishing = this.isNotePublished(file.path)
        menu.addItem((item) =>
          item
            .setTitle(publishing ? 'Stop publishing with Open Publish' : 'Publish with Open Publish')
            .setIcon(publishing ? 'cloud-off' : 'upload-cloud')
            .onClick(() => void this.toggleNote(file)),
        )
      }),
    )

    this.addCommand({
      id: 'setup',
      name: 'Open setup guide',
      callback: () => new SetupWizard(this.app, this).open(),
    })
    this.addCommand({
      id: 'trigger-build',
      name: 'Trigger a site build without publishing',
      callback: () => void this.triggerBuildOnly(),
    })
    this.addCommand({
      id: 'storage-self-test',
      name: 'Run storage self-test',
      callback: () => void this.runStorageSelfTest(),
    })
    this.addCommand({
      id: 'clean-up',
      name: 'Clean up unused files in storage',
      callback: () => void this.runGarbageCollection(),
    })
  }

  override async onunload(): Promise<void> {
    this.statusBar?.dispose()
    this.statusBar = null
    await this.saveHashCache()
  }

  // --- settings and cache -------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = migrateSettings(await this.loadData())
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  openSettings(): void {
    // `setting` is on the app object but not in the public typings.
    const app = this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void }
    }
    app.setting?.open()
    app.setting?.openTabById(this.manifest.id)
  }

  /**
   * The hash cache is kept out of data.json on purpose: it can reach a few
   * hundred KB, and data.json is round-tripped by Obsidian Sync.
   */
  private cachePath(): string {
    return normalizePath(`${this.manifest.dir}/${CACHE_FILE}`)
  }

  private async loadHashCache(): Promise<void> {
    try {
      const path = this.cachePath()
      if (!(await this.app.vault.adapter.exists(path))) return
      const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as unknown
      if (parsed && typeof parsed === 'object') this.hashCache = parsed as HashCache
    } catch {
      // A corrupt cache is not worth a message: entries are keyed by path,
      // mtime and size, so the worst case is that the next scan re-hashes.
      this.hashCache = {}
    }
  }

  private async saveHashCache(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.cachePath(), JSON.stringify(this.hashCache))
    } catch {
      // Losing the cache costs speed, never correctness.
    }
  }

  async clearHashCache(): Promise<void> {
    for (const key of Object.keys(this.hashCache)) delete this.hashCache[key]
    await this.saveHashCache()
  }

  // --- wiring -------------------------------------------------------------

  private destinationCache: { key: string; destination: Destination } | null = null

  /**
   * One destination per configuration, reused.
   *
   * `S3Destination` learns things about the provider as it goes (chiefly that
   * conditional writes are unsupported), and a fresh instance per call throws
   * that away, so every publish rediscovers it by burning three retries with
   * backoff before falling back. The cache is keyed on the settings so editing
   * credentials still takes effect immediately.
   *
   * The one construction site, and the only place in the plugin that knows
   * there is more than one kind. Everything above it, the publisher, the
   * scanner, the collector and the self-test, depends on `Destination` and
   * nothing narrower.
   */
  private destination(): Destination {
    if (!isDestinationConfigured(this.settings)) {
      throw new PublishError('not-configured', 'Storage is not set up yet.', {
        hint: 'Open the setup guide in Open Publish settings.',
      })
    }
    const settings = this.settings.destination
    const key = JSON.stringify(settings)
    if (this.destinationCache?.key !== key) {
      const destination =
        settings.type === 'gateway'
          ? new GatewayDestination(settings, this.http)
          : new S3Destination(settings, this.http)
      this.destinationCache = { key, destination }
    }
    return this.destinationCache.destination
  }

  private builder(): Builder | null {
    // A hook with no site address can still start a build; it just cannot
    // confirm one, which the builder reports for itself.
    if (!isHookConfigured(this.settings)) return null
    return new WebhookBuilder(
      {
        url: this.settings.builder.url,
        method: this.settings.builder.method,
        siteUrl: this.settings.builder.siteUrl,
        // No logsUrl. The builder never read it, and the copy that matters is
        // the one handed to `publish()`, which `verifyTimeoutError` uses.
      },
      this.http,
    )
  }

  async testDestination(): Promise<TestResult> {
    try {
      return await this.destination().test()
    } catch (error) {
      const publishError = toPublishError(error, 'The storage test failed.')
      return { ok: false, reason: publishError.message, hint: publishError.hint }
    }
  }

  async testBuilder(): Promise<BuilderTestResult> {
    const builder = this.builder()
    // `builder()` returns null only when the hook URL is missing. A missing
    // site URL is a real case too, but `test()` reports that one itself, and
    // naming both here sent people to check a field that was already filled in.
    if (!builder) return { ok: false, reason: 'No deploy hook URL is set yet.' }
    return builder.test()
  }

  // --- the flow -----------------------------------------------------------

  private openPublishModal(): void {
    // Mid-run the window is a view onto the session, so it opens whatever the
    // storage settings say: there is nothing left to configure.
    if (!this.session?.isRunning() && !isDestinationConfigured(this.settings)) {
      new Notice('Open Publish needs storage details first. Opening the setup guide.')
      this.openSetup()
      return
    }
    new PublishModal(this.app, this).open()
  }

  openSetup(): void {
    new SetupWizard(this.app, this).open()
  }

  /** Told by the publish window, so the plugin knows whether to announce results itself. */
  setPublishWindowOpen(open: boolean): void {
    this.windowOpen = open
  }

  async scan(options: {
    signal?: AbortSignal
    onProgress?: (message: string, current?: number, total?: number) => void
  }): Promise<ScanResult> {
    if (!this.hasher) throw new PublishError('not-configured', 'The plugin is still starting up.')
    const result = await scanVault({
      app: this.app,
      destination: this.destination(),
      hasher: this.hasher,
      rules: this.settings.selection,
      site: this.settings.site,
      autoIncludeEmbeds: this.settings.selection.autoIncludeEmbeds,
      pluginVersion: this.manifest.version,
      onProgress: options.onProgress,
      signal: options.signal,
    })
    // Storage that has moved since the last publish is why this screen is about
    // to show the entire vault as new: the new bucket has no `current.json`, so
    // the scan has nothing to diff against and every HEAD misses. The review is
    // where that surprise lands, so it is where the reason belongs.
    if (hasStorageMoved(this.settings)) result.warnings.push(storageMovedWarning(this.settings))
    return result
  }

  activeSession(): PublishSession | null {
    return this.session
  }

  /**
   * Start a publish, or hand back the one already running.
   *
   * The session is owned here and survives the window that started it, which is
   * what lets someone press Publish and get on with their day. `Publisher`'s own
   * single-flight guard is still the backstop for a double click that races this
   * check.
   */
  startPublish(scan: ScanResult, selection: PublishSelection, summary: PublishSummary): PublishSession {
    const running = this.session
    if (running?.isRunning()) return running

    const session = new PublishSession({
      summary,
      run: (onEvent, signal) =>
        this.publisher.publish(
          {
            scan,
            selection,
            destination: this.destination(),
            builder: this.builder(),
            readFile: (path) => this.readVaultFile(path),
            site: this.settings.site,
            pluginVersion: this.manifest.version,
            autoTrigger: this.settings.builder.autoTrigger,
            minIntervalMinutes: this.settings.builder.minIntervalMinutes,
            lastBuildTriggeredAt: this.settings.lastBuildTriggeredAt,
            logsUrl: this.settings.builder.logsUrl || undefined,
            signal,
          },
          onEvent,
        ),
    })

    this.session = session
    // The status bar is decoration. It runs inside `subscribe`, which is called
    // synchronously from here, so an exception in it would propagate out of
    // startPublish and leave the Publish button looking dead while the run
    // carried on invisibly. Nothing cosmetic gets to do that.
    session.subscribe((status) => {
      try {
        this.statusBar?.update(status, stateForSession(status, session.summary))
      } catch {
        // A publish in progress matters more than a line of text about it.
      }
    })
    void session.finished.then((status) => this.finishSession(session, status))
    return session
  }

  private async finishSession(session: PublishSession, status: SessionStatus): Promise<void> {
    const outcome = status.outcome
    if (outcome?.committed) {
      recordPublish(this.settings, outcome, Date.now())
      try {
        await this.saveSettings()
        await this.saveHashCache()
      } catch {
        // Local bookkeeping only. The notes are on the site either way, and the
        // worst this costs is a slower next scan, not worth alarming anyone.
      }
    }

    // With the window closed the status bar is the only sign anything happened,
    // and on mobile there is not even that, so say it out loud.
    if (!this.windowOpen) {
      const message = publishMessage(stateForSession(status, session.summary))
      const lines = [message.headline, message.stats, message.body].filter(Boolean).join('\n')
      new Notice(lines, message.tone === 'ok' ? 6000 : 12000)
    }
  }

  private async readVaultFile(path: string): Promise<ArrayBuffer> {
    const file = this.app.vault.getAbstractFileByPath(path) as TFile | null
    if (!file) throw new PublishError('storage-failed', `"${path}" disappeared from the vault while publishing.`)
    return this.app.vault.readBinary(file)
  }

  /**
   * Start a build without uploading anything: the fix for "content published,
   * but the build did not run".
   */
  async triggerBuildOnly(): Promise<void> {
    const builder = this.builder()
    if (!builder) {
      new Notice('No deploy hook is configured yet.')
      return
    }
    const snapshotId = this.settings.lastSnapshotId
    try {
      await builder.trigger(snapshotId ?? 'manual')
      this.settings.lastBuildTriggeredAt = Date.now()
      await this.saveSettings()
      new Notice('Build started.')
    } catch (error) {
      new Notice(toPublishError(error, 'The build could not be started.').toDisplayString(), 10000)
    }
  }

  /** Whether this path would be published as things currently stand. */
  isNotePublished(path: string): boolean {
    const frontmatter = this.app.metadataCache.getCache(path)?.frontmatter
    return getPublishFlag(path, frontmatter?.['publish'], this.settings.selection) === true
  }

  /**
   * Add or remove one file, without the user having to write a folder rule.
   *
   * Frontmatter outranks this, so when a note pins its own state say so rather
   * than recording a preference that will never take effect.
   */
  async toggleNote(file: TFile): Promise<void> {
    const frontmatter = this.app.metadataCache.getCache(file.path)?.frontmatter
    const fromFrontmatter = parsePublishFrontmatter(frontmatter?.['publish'])
    if (fromFrontmatter !== null) {
      new Notice(
        `"${file.basename}" sets publish: ${fromFrontmatter} in its frontmatter, which overrides everything else. ` +
          'Change it there.',
        8000,
      )
      return
    }

    const next = !this.isNotePublished(file.path)
    this.settings.selection.explicit[file.path] = next
    await this.saveSettings()
    new Notice(
      next
        ? `"${file.basename}" will be published on the next publish.`
        : `"${file.basename}" will be removed from the site on the next publish.`,
    )
  }

  // --- maintenance --------------------------------------------------------

  /**
   * Proves the properties the atomic design rests on, without touching the
   * live site: content-addressed writes, deduplication by hash, and the
   * compare-and-swap that stops a second device clobbering the first.
   */
  async runStorageSelfTest(): Promise<void> {
    const notice = new Notice('Running storage self-test…', 0)
    try {
      const results = await runSelfTest(this.destination(), Date.now())
      notice.hide()
      new Notice(results.join('\n'), 15000)
    } catch (error) {
      notice.hide()
      new Notice(`Self-test failed: ${toPublishError(error, 'Unknown error.').toDisplayString()}`, 15000)
    }
  }

  async runGarbageCollection(): Promise<void> {
    if (this.publisher.isPublishing()) {
      new Notice('A publish is running. Cleaning up now could delete files that build is about to read.', 8000)
      return
    }
    const notice = new Notice('Looking for unused files…', 0)
    try {
      const destination = this.destination()
      const plan = await planGc({ destination, onProgress: (message) => notice.setMessage(message) })
      notice.hide()

      if (plan.deletableObjects.length === 0 && plan.deletableSnapshots.length === 0) {
        new Notice(describeGcPlan(plan), 8000)
        return
      }

      // Second guard: re-check that no publish started while we were planning.
      if (this.publisher.isPublishing()) {
        new Notice('A publish started while checking. Cleanup cancelled.', 8000)
        return
      }

      const progress = new Notice(describeGcPlan(plan), 0)
      const deleted = await runGc(plan, destination, (message, current, total) =>
        progress.setMessage(`${message} ${current} of ${total}`),
      )
      progress.hide()
      new Notice(`Removed ${deleted} unused file(s).`, 6000)
    } catch (error) {
      notice.hide()
      new Notice(toPublishError(error, 'Cleanup failed.').toDisplayString(), 10000)
    }
  }
}
