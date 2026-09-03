import { Notice, Plugin, TFile, normalizePath } from 'obsidian'
import {
  DEFAULT_SETTINGS,
  ROLLBACK_HEADLINE,
  storageMovedWarning,
  hasStorageMoved,
  isDestinationConfigured,
  isHookConfigured,
  migrateSettings,
  recordPublish,
  rollbackWarning,
  secretRefOf,
} from './settings.ts'
import type { DestinationSettings, Settings } from './settings.ts'
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
import { listSiteVersions, planRollback, runRollback } from './core/rollback.ts'
import type { RollbackOptions, RollbackPlan, SiteVersionList } from './core/rollback.ts'
import { runSelfTest } from './core/selftest.ts'
import { PublishModal } from './ui/PublishModal.ts'
import { RollbackModal } from './ui/RollbackModal.ts'
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
  /** Whether this vault has a `publish.json`. Read once at load; see `detectObsidianPublish`. */
  private obsidianPublishConfig = false

  override async onload(): Promise<void> {
    await this.loadSettings()
    await this.loadHashCache()
    await this.detectObsidianPublish()
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
    // Named for what somebody in trouble will type, which is "roll back",
    // even though the window it opens goes forward as well and is called Site
    // history for that reason.
    this.addCommand({
      id: 'rollback',
      name: 'Roll the site back to an earlier version',
      callback: () => this.openRollbackModal(),
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
    // There is no public API for this. `App` exposes workspace, vault,
    // metadataCache, fileManager and a handful more, and nothing at all for
    // settings, so `app.setting` is the only route and it is undocumented.
    //
    // Kept rather than dropped, because the alternative is removing a recovery
    // path people reach from a failed publish, and an undocumented call that
    // works today beats no way back. But its absence is now reported instead of
    // swallowed: the window that sends people here has already closed by the
    // time this runs, so a silent no-op would strand them mid-recovery with
    // nothing on screen and nothing to try.
    const app = this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void }
    }
    try {
      if (!app.setting) throw new Error('no settings API on this version')
      app.setting.open()
      app.setting.openTabById(this.manifest.id)
    } catch {
      new Notice('Could not open settings from here. Go to Settings, then Community plugins, then Open Publish.', 8000)
    }
  }

  // --- Obsidian Publish's leftovers ---------------------------------------

  /**
   * `<config dir>/publish.json`, the only local state Obsidian Publish keeps.
   *
   * Hardcoding `.obsidian` here would be a bug, and it bites exactly the wrong
   * people: anyone who moved their config directory is disproportionately a
   * long-time user, which is disproportionately the population who paid for
   * Publish for years. `Vault.configDir` is public typed API, so there is no
   * cast and no excuse.
   *
   * This reads the config directory and never writes to it. `isAlwaysExcluded`
   * guarantees nothing under a dot-folder can ever be published, so both the
   * read-only promise and the never-publish-credentials guarantee hold
   * unchanged.
   */
  private publishConfigPath(): string {
    return normalizePath(`${this.app.vault.configDir}/publish.json`)
  }

  /**
   * Cached at load, so the two places that offer the import stay synchronous.
   *
   * `FolderModal.render` and the wizard's step 6 both draw in one pass and are
   * driven that way by the tests; neither should have to learn to render a
   * pending state for one boolean. The text is re-read when the button is
   * pressed, because the file outlives an Obsidian session and somebody who
   * edits their Publish folders and imports again must not get a stale plan.
   */
  private async detectObsidianPublish(): Promise<void> {
    try {
      this.obsidianPublishConfig = await this.app.vault.adapter.exists(this.publishConfigPath())
    } catch {
      // Absence and unreadability are the same offer here: none.
      this.obsidianPublishConfig = false
    }
  }

  hasObsidianPublishConfig(): boolean {
    return this.obsidianPublishConfig
  }

  /**
   * The file's text, or null.
   *
   * A failed read and an absent file collapse into one answer deliberately:
   * the advice either way is the same, so distinguishing them would only
   * produce a second sentence nobody can act on differently. Obsidian Sync
   * carries core plugin settings by default and Publish is a core plugin, so
   * the file usually travels between devices, but iCloud and Git setups
   * frequently exclude the config directory outright. Absence is an ordinary
   * state, never an error.
   */
  async readObsidianPublishConfig(): Promise<string | null> {
    try {
      const path = this.publishConfigPath()
      if (!(await this.app.vault.adapter.exists(path))) return null
      return await this.app.vault.adapter.read(path)
    } catch {
      return null
    }
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

  private destinationCache: { key: string; secret: string; destination: Destination } | null = null

  /**
   * One destination per configuration, reused.
   *
   * `S3Destination` learns things about the provider as it goes (chiefly that
   * conditional writes are unsupported), and a fresh instance per call throws
   * that away, so every publish rediscovers it by burning three retries with
   * backoff before falling back. The cache is keyed on the settings so editing
   * any of them still takes effect immediately.
   *
   * The secret is compared separately because it is no longer *in* the
   * settings. Keying on the settings alone would mean that rotating a key
   * behind an unchanged name left this signing with the old value until
   * Obsidian restarted: a publish failing on credentials the user had already
   * corrected. It is not a second copy of anything, either. The destination
   * below holds the same string for as long as it lives; this is a reference to
   * it, kept so the next call can tell whether it is still the current one.
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
    const secret = this.resolveSecret(settings)
    const key = JSON.stringify(settings)
    if (this.destinationCache?.key !== key || this.destinationCache.secret !== secret) {
      const destination =
        settings.type === 'gateway'
          ? new GatewayDestination({ ...settings, token: secret }, this.http)
          : new S3Destination({ ...settings, secretAccessKey: secret }, this.http)
      this.destinationCache = { key, secret, destination }
    }
    return this.destinationCache.destination
  }

  /**
   * The name in `data.json`, turned into the value that signs a request.
   *
   * The whole of the boundary this change exists to create. Above it, settings
   * hold a reference; below it, `S3Config` and `GatewayConfig` take a real
   * credential and have not changed at all, which is why the signer and its
   * tests did not have to move.
   *
   * A missing entry is the case worth spending words on. Obsidian's keychain is
   * per device and does not sync, so opening a synced vault on a second machine
   * lands here with settings that look complete and no secret behind them. Left
   * to fall through, that would reach storage as a signature failure, which
   * reads back as "your keys were rejected" and sends people off to reissue
   * credentials that were never wrong.
   */
  private resolveSecret(settings: DestinationSettings): string {
    const ref = secretRefOf(settings)
    const secret = this.app.secretStorage.getSecret(ref)
    if (!secret) {
      throw new PublishError('not-configured', `This device has no secret named "${ref}".`, {
        hint:
          'Obsidian keeps secrets on each device separately, so they never travel with your vault. Link it ' +
          'again on this one in Open Publish settings.',
      })
    }
    return secret
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
    if (!this.session?.isRunning()) {
      if (!isDestinationConfigured(this.settings)) {
        new Notice('Open Publish needs storage details first. Opening the setup guide.')
        this.openSetup()
        return
      }
      // Configured, and still unable to sign anything *here*. This is the vault
      // arriving on a second device: `data.json` syncs and Obsidian's keychain
      // does not, so every field looks filled in and the one that matters is
      // not on this machine.
      //
      // Said before the window opens rather than after a scan, because the scan
      // cannot succeed and watching it run first teaches nothing. Settings
      // rather than the setup guide: the guide is six steps, five of them are
      // already done and synced, and calling this "setup" would send someone
      // looking for work that does not exist.
      if (!this.hasStorageSecret()) {
        new Notice(
          'This device does not have the storage key for this vault yet, because Obsidian keeps keys on each ' +
            'device separately. Opening settings so you can link it.',
          10000,
        )
        this.openSettings()
        return
      }
    }
    new PublishModal(this.app, this).open()
  }

  /** Whether the credential the settings name is on *this* device. */
  private hasStorageSecret(): boolean {
    return this.app.secretStorage.getSecret(secretRefOf(this.settings.destination)) !== null
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
      urlStyle: this.settings.urlStyle,
      pluginVersion: this.manifest.version,
      onProgress: options.onProgress,
      signal: options.signal,
    })
    // Storage that has moved since the last publish is why this screen is about
    // to show the entire vault as new: the new bucket has no `current.json`, so
    // the scan has nothing to diff against and every HEAD misses. The review is
    // where that surprise lands, so it is where the reason belongs.
    if (hasStorageMoved(this.settings)) result.warnings.push(storageMovedWarning(this.settings))
    // And, for the same reason one line up, why the site is showing something
    // other than what this vault last published. Without it, a review screen
    // full of changes after a rollback is a mystery.
    const rolledBack = rollbackWarning(this.settings)
    if (rolledBack) result.warnings.push(`${ROLLBACK_HEADLINE} ${rolledBack}`)
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
            // Preflight otherwise trusts the live snapshot to name only objects
            // that are really in storage. A bucket that has just changed under
            // us is the one case where that is a guess, so check everything.
            verifyAll: hasStorageMoved(this.settings),
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
    // `buildTriggered` without `committed` is a repair: no new snapshot, but a
    // build allowance really was spent, and the throttle has to know.
    if (outcome && (outcome.committed || outcome.buildTriggered)) {
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
    const file = this.app.vault.getFileByPath(path)
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

  // --- site history -------------------------------------------------------

  /**
   * Open Site history, or say why it cannot be opened.
   *
   * The same two checks the publish window makes, for the same reasons: with no
   * storage details there is nothing to list, and on a second device the
   * settings all look filled in while the one credential that signs a request
   * is not on this machine.
   */
  private openRollbackModal(): void {
    if (!isDestinationConfigured(this.settings)) {
      new Notice('Open Publish needs storage details first. Opening the setup guide.')
      this.openSetup()
      return
    }
    if (!this.hasStorageSecret()) {
      new Notice(
        'This device does not have the storage key for this vault yet, because Obsidian keeps keys on each ' +
          'device separately. Opening settings so you can link it.',
        10000,
      )
      this.openSettings()
      return
    }
    new RollbackModal(this.app, this).open()
  }

  /** Every version of the site still in storage, newest first. */
  async listSiteVersions(options: RollbackOptions = {}): Promise<SiteVersionList> {
    this.refuseWhilePublishing()
    return listSiteVersions(this.destination(), options)
  }

  /** What making that version live would change. Changes nothing itself. */
  async planRollback(targetId: string, options: RollbackOptions = {}): Promise<RollbackPlan> {
    this.refuseWhilePublishing()
    return planRollback(this.destination(), targetId, options)
  }

  /**
   * Move the pointer, then ask the host to rebuild.
   *
   * Two outcomes, kept apart on purpose and in the same way a publish keeps
   * them apart: once `current.json` is written the rollback has happened, full
   * stop, and nothing the host does or fails to do afterwards turns that into
   * a failed rollback. The result says which of the two went how.
   */
  async rollBackTo(plan: RollbackPlan): Promise<RollbackResult> {
    // The second of the two guards, and the one that matters: the plan was
    // made before an object listing, which takes time, and a publish that
    // started during it is committing a pointer of its own.
    this.refuseWhilePublishing()

    await runRollback(this.destination(), plan)

    this.settings.lastSnapshotId = plan.target.id
    // Recorded only while a newer version exists in storage. The list goes
    // forward too, and telling somebody their site shows an older version
    // right after they redid their way to the newest one would be exactly the
    // lie that "Site history" is named to avoid. `behind` is the right test
    // rather than "did this go backwards": rolling forward without reaching
    // the top leaves the site behind, and the panel has to stay.
    this.settings.lastRollback = plan.behind
      ? { to: plan.target.id, from: plan.from, at: Date.now() }
      : null

    const build = await this.triggerRollbackBuild(plan.target.id)
    try {
      await this.saveSettings()
    } catch {
      // Local bookkeeping only. The site is pointed at that version either way.
    }
    return { snapshotId: plan.target.id, ...build }
  }

  /**
   * The rebuild, deliberately past the throttle.
   *
   * `throttleState` exists to stop *automatic* publish-driven builds burning a
   * monthly allowance. A rollback is manual, rare, and frequently urgent:
   * being told to wait four minutes with a private note live would be
   * indefensible. `autoTrigger` is ignored for the same reason it is ignored
   * by "Trigger a site build without publishing": both are somebody asking.
   */
  private async triggerRollbackBuild(snapshotId: string): Promise<Omit<RollbackResult, 'snapshotId'>> {
    const builder = this.builder()
    if (!builder) return { build: 'not-configured' }
    try {
      await builder.trigger(snapshotId)
      this.settings.lastBuildTriggeredAt = Date.now()
      return { build: 'started' }
    } catch (error) {
      return {
        build: 'failed',
        buildError: toPublishError(error, 'The build could not be started.').toDisplayString(),
      }
    }
  }

  /**
   * The first of the two in-flight-publish guards, taken twice.
   *
   * A rollback racing a publish decides the winner by whichever PUT lands
   * last, which is a decision neither of them made. Refusing is the same
   * answer `runGarbageCollection` gives, for the same reason.
   */
  private refuseWhilePublishing(): void {
    if (this.publisher.isPublishing()) {
      throw new PublishError('storage-conflict', 'A publish is running.', {
        hint: 'Wait for it to finish, then choose a version.',
      })
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

/**
 * What a rollback did, in the two halves it is honest to keep apart.
 *
 * The pointer moved: that is the rollback, and it succeeded or this value does
 * not exist. `build` is the host catching up, and none of its outcomes is a
 * reason to tell somebody their rollback failed.
 */
export interface RollbackResult {
  /** The version `current.json` now names. */
  snapshotId: string
  build: 'started' | 'not-configured' | 'failed'
  buildError?: string
}
