/**
 * data.json schema and migrations.
 *
 * Kept deliberately small: apart from credentials and rules, no local state is
 * load-bearing. Every scan reads `current.json` from the bucket first, so a
 * reinstalled plugin with re-entered credentials produces a correct diff with
 * no local cache at all.
 *
 * The hash cache lives in a *separate* file (cache.json) because it reaches a
 * few hundred KB and must not bloat the settings file that Obsidian Sync
 * round-trips between devices.
 */

import type { S3Config } from './destinations/s3.ts'
import type { GatewayConfig } from './destinations/gateway.ts'
import { inferProvider, isProviderId, providerKind } from './destinations/providers.ts'
import type { ProviderId } from './destinations/providers.ts'
import { inferHost, isHostId } from './builders/hosts.ts'
import type { HostId } from './builders/hosts.ts'
import { isUrlStyle } from './core/slug.ts'
import { DEFAULT_LOCALE, directionFor, isLocale } from './core/locales.ts'
import type { UrlStyle } from './core/slug.ts'
import { snapshotTime } from './core/snapshot.ts'
import type { SnapshotSite } from './core/snapshot.ts'

export const SETTINGS_VERSION = 1

export interface WebhookBuilderSettings {
  type: 'webhook'
  /**
   * `host` sits *beside* `type`, exactly as `provider` sits beside the
   * destination's. `type` is the builder-kind discriminant a future Git-push
   * builder would need; Pages, Netlify and Vercel are all `type: 'webhook'`,
   * same config and same code path.
   *
   * It is a label, a set of instructions and a warning. `WebhookBuilder` never
   * sees it, and the hook URL it is inferred from stays the only source of
   * truth about which host this is.
   */
  host: HostId
  url: string
  method: 'POST' | 'GET'
  siteUrl: string
  logsUrl: string
  autoTrigger: boolean
  /**
   * Five minutes, because Cloudflare Pages allows one build at a time.
   *
   * Worth knowing what it is not: protection against a *monthly* allowance. At
   * five minutes this permits about 8,600 builds a month, so on Netlify's
   * roughly 20 the only real defence is `autoTrigger`. The settings panel says
   * so rather than quietly raising this for anyone.
   */
  minIntervalMinutes: number
}

export interface SelectionSettings {
  includes: string[]
  excludes: string[]
  explicit: Record<string, boolean>
  /** Design note 2.8. Default on. */
  autoIncludeEmbeds: boolean
}

/**
 * `provider` sits *beside* `type`, not in place of it. `type` is the
 * destination-kind discriminant, and it is the one field here that decides
 * which class `main.ts` builds. R2, B2 and Wasabi are all `type: 's3'`, same
 * config and same code path; the provider is a label and a set of prefills,
 * and `S3Destination` never sees it.
 */
export type S3DestinationSettings = Omit<S3Config, 'secretAccessKey'> & {
  type: 's3'
  provider: ProviderId
  /**
   * The *name* of a keychain entry, never the key itself.
   *
   * This is the one field here that is not the signer's own config, and
   * breaking that intersection is the whole of this design. `S3Config` still
   * takes a real `secretAccessKey`, so `s3.ts` and `sigv4.ts` are untouched;
   * `main.ts` is the single place that turns a name into a value, and the
   * value never reaches `data.json`.
   *
   * Ids are lowercase alphanumeric with dashes, at most 64 characters, and
   * they live in one namespace shared by every installed plugin, so the name
   * this project suggests is prefixed with its own.
   */
  secretRef: string
}

/**
 * The gateway: a Worker address and a token, and deliberately nothing else.
 *
 * No bucket, no region, no endpoint, because the Worker holds all three and the
 * plugin is better off not knowing them. The cost is real and shows up in one
 * place: the setup wizard cannot prefill the build's `OP_BUCKET` and
 * `OP_ENDPOINT` for a gateway user, and says so rather than guessing.
 *
 * Not even the token: `tokenRef` names a keychain entry, for the same reason
 * and with the same boundary as `S3DestinationSettings.secretRef`.
 */
export type GatewayDestinationSettings = Omit<GatewayConfig, 'token'> & {
  type: 'gateway'
  provider: 'gateway'
  /** The name of a keychain entry, never the token. See `secretRef`. */
  tokenRef: string
}

export type DestinationSettings = S3DestinationSettings | GatewayDestinationSettings

export interface Settings {
  version: number
  destination: DestinationSettings
  builder: WebhookBuilderSettings
  selection: SelectionSettings
  site: SnapshotSite
  /**
   * Whether the site also answers at the URLs Obsidian Publish gave it.
   *
   * Not a `SnapshotSite` option, even though it changes what the site serves.
   * Those are intent any generator can honour; this one is a rule for turning a
   * vault path into an address, which is the plugin's own job and nobody
   * else's. What crosses into the snapshot is the result: a list of addresses
   * per file, which a generator either serves or ignores.
   */
  urlStyle: UrlStyle
  lastSnapshotId: string | null
  lastPublishedAt: number | null
  /** Drives build throttling; separate from lastPublishedAt because a publish can skip the build. */
  lastBuildTriggeredAt: number | null
  /**
   * Where the last publish actually went, as a `storageTarget` signature.
   *
   * Kept so that changing storage after publishing can be recognised for what
   * it is: a migration, not a setting change. Comparing against this is a
   * *state*, not an event, which is what lets the warning be a panel that
   * stays until the situation is resolved rather than a Notice fired on some
   * keystroke and then gone.
   */
  lastPublishedTarget: string | null
  /**
   * Where the last publish was *served from*, as a `hostTarget` signature.
   *
   * The hosting counterpart of `lastPublishedTarget`, and the same kind of
   * state rather than event. Switching host after publishing is a migration
   * with its own three consequences, none of which the user is told about by
   * default. See `hasHostMoved`.
   */
  lastPublishedHostTarget: string | null
  /**
   * The rollback in force, or null.
   *
   * A state rather than an event, for the same reason `lastPublishedTarget` is:
   * "your site is behind your notes" stays true until somebody publishes
   * forward, and a Notice fired once at rollback time is gone by the moment it
   * matters. `recordPublish` is what ends it, because publishing forward is
   * what resolves it.
   *
   * `to` and `from` are snapshot IDs, and `at` is when the pointer moved. The
   * version's *own* date is read back out of `to`, which carries it: see
   * `snapshotTime`.
   */
  lastRollback: { to: string; from: string | null; at: number } | null
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  destination: {
    type: 's3',
    // The recommended provider, so a fresh vault opens on it. Its own defaults
    // are the same values a fresh vault had before the catalogue existed.
    provider: 'r2',
    endpoint: '',
    bucket: '',
    region: 'auto',
    accessKeyId: '',
    secretRef: '',
    prefix: '',
    forcePathStyle: true,
  },
  builder: {
    type: 'webhook',
    // The recommended host, so a fresh vault opens on it, and the interval
    // below is that host's own constraint rather than a number from nowhere.
    host: 'cloudflare-pages',
    url: '',
    method: 'POST',
    siteUrl: '',
    logsUrl: '',
    autoTrigger: true,
    minIntervalMinutes: 5,
  },
  selection: {
    includes: [],
    excludes: [],
    explicit: {},
    autoIncludeEmbeds: true,
  },
  site: {
    title: 'My Notes',
    homepage: '',
    locale: DEFAULT_LOCALE,
    dir: 'ltr',
    noIndex: false,
    showThemeToggle: true,
    // Off by default: people write notes with single newlines and expect to see
    // them. Markdown's strict rule turns a list of short lines into one blob.
    strictLineBreaks: false,
    showNavigation: true,
    showSearch: true,
    showGraph: true,
    showOutline: true,
    showBacklinks: true,
    showTags: true,
    analytics: { provider: 'none', id: '' },
  },
  // Clean URLs, and nothing else, for everyone who is not migrating.
  urlStyle: 'clean',
  lastSnapshotId: null,
  lastPublishedAt: null,
  lastBuildTriggeredAt: null,
  lastPublishedTarget: null,
  lastPublishedHostTarget: null,
  lastRollback: null,
}

function cloneDefaults(): Settings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings
}

/**
 * Merge stored data over the defaults, one level deep per section.
 *
 * Written as an explicit merge rather than a spread of unknown data so that a
 * settings file from a future version cannot inject fields we never validate.
 */
export function migrateSettings(raw: unknown): Settings {
  const settings = cloneDefaults()
  if (typeof raw !== 'object' || raw === null) return settings
  const stored = raw as Partial<Settings>

  settings.destination = resolveDestination(stored.destination)
  if (stored.builder) Object.assign(settings.builder, stored.builder, { type: 'webhook' })
  if (stored.selection) {
    Object.assign(settings.selection, stored.selection)
    settings.selection.includes = asStringArray(stored.selection.includes)
    settings.selection.excludes = asStringArray(stored.selection.excludes)
    settings.selection.explicit = asBooleanRecord(stored.selection.explicit)
  }
  if (stored.site) {
    const analytics = stored.site.analytics
    Object.assign(settings.site, stored.site)
    settings.site.analytics = {
      provider: analytics?.provider ?? 'none',
      id: typeof analytics?.id === 'string' ? analytics.id : '',
    }
    // Checked against the table rather than copied across, for the same reason
    // `urlStyle` is below: an unrecognised tag would reach the dropdown, which
    // cannot render it, and then a published snapshot, where jotter's schema
    // rejects it at *build* time: a broken site rather than a wrong one.
    settings.site.locale = isLocale(stored.site.locale) ? stored.site.locale : DEFAULT_SETTINGS.site.locale
    // Re-derived on every load rather than trusted, so a hand-edited or stale
    // data.json cannot hold a direction that disagrees with its language. This
    // and the settings dropdown are the only two places `dir` is ever written.
    settings.site.dir = directionFor(settings.site.locale)
  }

  settings.builder.host = resolveHost(stored.builder)

  // Checked against the two values rather than copied across, the same way
  // `analytics.provider` is: an unrecognised style would reach the dropdown,
  // which cannot render it, and the scanner, which would treat anything that is
  // not the redirect style as plain clean URLs anyway. Falling back says that
  // out loud instead of half-applying it.
  settings.urlStyle = isUrlStyle(stored.urlStyle) ? stored.urlStyle : DEFAULT_SETTINGS.urlStyle

  settings.lastSnapshotId = typeof stored.lastSnapshotId === 'string' ? stored.lastSnapshotId : null
  settings.lastPublishedAt = typeof stored.lastPublishedAt === 'number' ? stored.lastPublishedAt : null
  settings.lastBuildTriggeredAt =
    typeof stored.lastBuildTriggeredAt === 'number' ? stored.lastBuildTriggeredAt : null
  settings.lastPublishedTarget =
    typeof stored.lastPublishedTarget === 'string'
      ? stored.lastPublishedTarget
      : // A vault that published before this field existed did so with the
        // settings it still holds. Assuming that is what makes the "you have
        // moved your storage" warning work for people upgrading, rather than
        // only for people who publish once more first.
        settings.lastSnapshotId
        ? storageTarget(settings.destination)
        : null
  settings.lastPublishedHostTarget =
    typeof stored.lastPublishedHostTarget === 'string'
      ? stored.lastPublishedHostTarget
      : settings.lastSnapshotId
        ? hostTarget(settings.builder)
        : null
  // Validated field by field rather than merged, the same way `site.analytics`
  // is: this one decides whether a panel claims the site is behind the notes,
  // and a half-shaped object from a hand-edited data.json would either crash
  // the settings tab or fire a warning about a rollback that never happened.
  settings.lastRollback = resolveRollback(stored.lastRollback)
  settings.version = SETTINGS_VERSION
  return settings
}

function resolveRollback(stored: unknown): Settings['lastRollback'] {
  if (typeof stored !== 'object' || stored === null) return null
  const raw = stored as Partial<NonNullable<Settings['lastRollback']>>
  if (typeof raw.to !== 'string' || !raw.to) return null
  return {
    to: raw.to,
    from: typeof raw.from === 'string' ? raw.from : null,
    at: typeof raw.at === 'number' ? raw.at : 0,
  }
}

/**
 * The gateway destination a fresh switch to it starts from.
 *
 * A function rather than a constant, because the caller mutates what it gets
 * back and a shared object would hand every vault the same one.
 */
export function emptyGatewayDestination(): GatewayDestinationSettings {
  return { type: 'gateway', provider: 'gateway', workerUrl: '', tokenRef: '', prefix: '' }
}

/** The same, for the other shape. What a fresh vault has always started from. */
export function emptyS3Destination(): S3DestinationSettings {
  return cloneDefaults().destination as S3DestinationSettings
}

/**
 * Which of the two shapes a stored destination is, and its fields.
 *
 * `type` is the only thing consulted, so a settings file written before the
 * gateway existed has no way to be read as one: it has no `type`, and every
 * field it does have is S3's. That is the whole of "a vault configured for
 * direct S3 must load unchanged".
 *
 * The two branches share no fields, which is deliberate rather than tidy.
 * Switching storage discards the credentials of the kind being left behind, so
 * a vault that moves to the gateway stops carrying a reference to a read-write
 * S3 key it no longer uses.
 *
 * What is discarded now is the *reference*. The keychain entry it named
 * survives, which is a deliberate change of behaviour rather than an oversight:
 * the keychain is shared with every other plugin and is not this plugin's to
 * clear, switching provider is routinely a thing people switch back from, and
 * an entry nobody references costs nothing until someone deletes it in
 * Obsidian's own keychain settings, which is where deleting it belongs.
 */
function resolveDestination(stored: unknown): DestinationSettings {
  const raw = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, unknown>

  if (raw.type === 'gateway') {
    const gateway = emptyGatewayDestination()
    gateway.workerUrl = asTrimmedString(raw.workerUrl)
    gateway.tokenRef = asTrimmedString(raw.tokenRef)
    gateway.prefix = asTrimmedString(raw.prefix).replace(/^\/+|\/+$/g, '')
    return gateway
  }

  const s3 = cloneDefaults().destination as S3DestinationSettings
  // `secretAccessKey` is dropped rather than carried across, and this is the
  // one place that can drop it. The assign below copies whatever `data.json`
  // held, so a file written by a build that stored the key inline would have it
  // copied into settings and written straight back out on the next save: the
  // secret would outlive the change meant to remove it. Named here so a reader
  // who does not know that history cannot delete the line as dead code.
  const { secretAccessKey: _inlinedSecret, ...rest } = raw
  Object.assign(s3, rest, { type: 's3' })
  s3.secretRef = asTrimmedString(raw.secretRef)
  s3.provider = resolveProvider(raw)
  return s3
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Which provider label a stored destination gets.
 *
 * Inference runs *only* when the endpoint is byte-identical to what a template
 * produces, trailing slashes aside, which the signer already ignores
 * (`s3.ts` strips them before building a URL). Anything else is "Other". So
 * migration can never change a working configuration: the worst a wrong guess
 * costs is a label, because nothing derived from it is ever sent.
 *
 * A stored id we do not recognise (one from a newer build, arriving here after
 * a downgrade) is re-inferred rather than kept. Keeping it would mean a UI that
 * cannot render its own state, and re-inferring loses nothing: the endpoint is
 * the source of truth, and a newer build will label it with its own table
 * again on the way back up.
 */
function resolveProvider(stored: Record<string, unknown>): ProviderId {
  // A gateway label on an S3 destination is not an explicit choice, it is a
  // half-applied switch, and honouring it would leave the UI rendering a
  // Worker form over a bucket's credentials. Re-infer instead.
  if (isProviderId(stored.provider) && providerKind(stored.provider) === 's3') return stored.provider
  const endpoint = typeof stored.endpoint === 'string' ? stored.endpoint : ''
  // An empty endpoint is "not set up yet", not "unrecognisable", so it keeps
  // the recommended default instead of falling to Other.
  if (!endpoint.trim()) return DEFAULT_SETTINGS.destination.provider
  return inferProvider(endpoint).id
}

/**
 * Which host label a stored builder gets.
 *
 * The same rule as `resolveProvider`, for the same reason: inference runs only
 * on an exact hook-URL match, so migration can never change a working
 * configuration. Anything else is "Another host", and the worst a wrong guess
 * costs is a label, because nothing derived from it is ever sent and no stored
 * number is ever rewritten from it. `minIntervalMinutes` and `autoTrigger` in
 * particular are left exactly as the user set them: they govern somebody's
 * bill, and a guess is no basis for changing one.
 *
 * A stored id we do not recognise (one from a newer build, arriving here after
 * a downgrade) is re-inferred rather than kept, so the UI can always render its
 * own state.
 */
function resolveHost(stored: Partial<WebhookBuilderSettings & { host?: unknown }> | undefined): HostId {
  if (isHostId(stored?.host)) return stored.host
  const url = typeof stored?.url === 'string' ? stored.url : ''
  // An empty hook URL is "not set up yet", not "unrecognisable", so it keeps
  // the recommended default instead of falling to Another host.
  if (!url.trim()) return DEFAULT_SETTINGS.builder.host
  return inferHost(url)
}

/**
 * Everything about a destination that decides *where* an object lives.
 *
 * Region is deliberately absent: it changes how a request is signed, not what
 * it addresses, and a wrong one fails loudly on the next request rather than
 * quietly building the wrong site. The provider id is absent for the same kind
 * of reason: it is a label, so relabelling storage that has not moved must not
 * look like a migration.
 */
export function storageTarget(destination: DestinationSettings): string {
  if (destination.type === 'gateway') {
    // Nothing in common with the S3 form on purpose. Pointing a gateway at the
    // bucket you were already publishing to directly *is* a move worth
    // warning about: the content has not gone anywhere, but the route the
    // build must be told about has changed, and the read-only keys in the
    // host's environment are still the old ones.
    const worker = destination.workerUrl.trim().replace(/\/+$/, '')
    return `gateway|${worker}|${(destination.prefix ?? '').replace(/^\/+|\/+$/g, '')}`
  }
  const endpoint = destination.endpoint.trim().replace(/\/+$/, '')
  const prefix = (destination.prefix ?? '').replace(/^\/+|\/+$/g, '')
  const addressing = destination.forcePathStyle === false ? 'host' : 'path'
  return `${endpoint}|${destination.bucket.trim()}|${prefix}|${addressing}`
}

/**
 * True when the site's content lives somewhere other than where the plugin is
 * about to publish. See the warning in the settings tab: three separate things
 * go wrong at once here, and the user is told about none of them by default.
 */
export function hasStorageMoved(settings: Settings): boolean {
  if (!settings.lastSnapshotId || !settings.lastPublishedTarget) return false
  if (!isDestinationConfigured(settings)) return false
  return storageTarget(settings.destination) !== settings.lastPublishedTarget
}

export const STORAGE_MOVED_WARNING =
  "Your site's content lives in the old storage. Publishing here uploads everything again, and your site " +
  "keeps building from the old storage until you update the values in your host's settings. " +
  'Step 4 of the setup guide has them.'

/**
 * The same warning, hedged exactly as far as the truth requires.
 *
 * A gateway holds no bucket name, so when one is on either side of the move the
 * plugin cannot tell "the same bucket, reached a new way" from "a different
 * bucket". Those have opposite consequences, and the sentence above asserts the
 * second one: it promises a full re-upload and a site building from the old
 * storage. On the path the gateway's own README recommends, pointing a Worker
 * at the bucket you already publish to, both halves are wrong. Content is
 * addressed by hash, so nothing re-uploads, and the build reads the same bucket
 * it always did.
 *
 * Firing at all is still right. The route changed, `OP_PREFIX` may have to
 * change with it, and that is worth a panel. Only the certainty has to go.
 */
export const STORAGE_REROUTED_WARNING =
  'This is a different route to your storage than the one you last published through. If it reaches the same ' +
  'bucket, nothing is lost and nothing uploads twice. If it reaches a different one, your site keeps building ' +
  "from the old bucket until you update the values in your host's settings. Step 4 of the setup guide has them, " +
  'and OP_PREFIX is the one to check first.'

/** Which of the two the situation actually warrants. */
export function storageMovedWarning(settings: Settings): string {
  const publishedThroughGateway = (settings.lastPublishedTarget ?? '').startsWith('gateway|')
  return settings.destination.type === 'gateway' || publishedThroughGateway
    ? STORAGE_REROUTED_WARNING
    : STORAGE_MOVED_WARNING
}

/**
 * Which host is serving the site, as far as this vault knows.
 *
 * The host label, and nothing else.
 *
 * The deploy hook URL is left out because it is a credential: a second copy of
 * it, in a field nothing masks and nothing clears, would outlive the day
 * somebody rotates the first one. `storageTarget` leaves the access keys out
 * for the same reason.
 *
 * The site address is left out because it moves for reasons that are not a host
 * move, and the commonest of them is one this project's own documentation tells
 * people to do: put a custom domain in front of the site and update the address
 * here. Including it meant following that advice raised a panel telling the user
 * their site was served somewhere else and sending them off to re-enter
 * environment variables that were already correct. A warning that fires on the
 * happy path is worse than no warning, because it is the one people learn to
 * ignore before the real one arrives.
 *
 * Two things this deliberately cannot see, both of which cost a missing warning
 * rather than a wrong one:
 *
 *  - moving to a different project on the *same* host, which no signal here can
 *    distinguish from staying put;
 *  - correcting a host label by hand after publishing, which looks identical to
 *    a move and shows the panel until the next build clears it.
 */
export function hostTarget(builder: Pick<WebhookBuilderSettings, 'host'>): string {
  return builder.host
}

/**
 * True when the site is still being served by a host other than the one the
 * plugin is now pointed at.
 *
 * Three things go wrong at once, and none of them looks like a failure. The old
 * host keeps serving the live site indefinitely, so nothing breaks; it just
 * stops updating. The new host needs every OP_* variable entered again,
 * including the read-only storage keys the plugin does not hold. And the site
 * address now names a site that has never been built, so verification polls a
 * 404 for the full ten minutes and reports "Saved, still waiting".
 */
export function hasHostMoved(settings: Settings): boolean {
  if (!settings.lastSnapshotId || !settings.lastPublishedHostTarget) return false
  // The hook URL alone, not the site address: a publish needs only the hook, so
  // that is the point from which pointing somewhere new can do damage. Asking
  // for the address too meant a vault that published before the address was
  // filled in reported a move the moment setup was finished.
  if (!isHookConfigured(settings)) return false
  return hostTarget(settings.builder) !== settings.lastPublishedHostTarget
}

/**
 * What a finished publish leaves behind in settings.
 *
 * Extracted from `main.ts` so it can be tested at all. Everything else the
 * plugin decides has a test; this did not, because `main.ts` imports Obsidian's
 * `Plugin` and nothing can load it outside the app. That mattered more than it
 * looks: these five fields are what every "has anything moved" question is
 * answered against later, and a wrong one is invisible until a warning fires,
 * or fails to, weeks afterwards.
 *
 * `now` is passed in rather than read here, so a test can say when.
 *
 * Nothing happens unless the publish committed. An uncommitted run changed
 * nothing about where the site's content lives, so recording it would be
 * recording a publish that did not happen.
 */
export function recordPublish(settings: Settings, outcome: PublishRecord, now: number): void {
  if (!outcome.committed) return
  settings.lastSnapshotId = outcome.snapshotId
  settings.lastPublishedAt = now
  // Publishing forward is what a rollback is waiting for, so this is where the
  // "your site is showing an older version" panel ends. Gated on `committed`
  // along with everything else here: a publish that found nothing to change
  // left the site exactly as the rollback left it, and clearing the panel then
  // would hide a state that is still true.
  settings.lastRollback = null
  // Where it went, so that pointing the plugin somewhere else later can be
  // recognised as the migration it is rather than passing for a setting change.
  // See `hasStorageMoved`.
  settings.lastPublishedTarget = storageTarget(settings.destination)
  if (!outcome.buildTriggered) return
  settings.lastBuildTriggeredAt = now
  // And which host is now serving it. Gated on the build actually being asked
  // for, not merely on the content being committed: with automatic builds off,
  // throttled, or refused, the notes are in storage and the *old* host is still
  // serving the site. Recording the new host here would clear the "you have
  // moved host" panel at precisely the moment it is telling the truth.
  settings.lastPublishedHostTarget = hostTarget(settings.builder)
}

/** The part of a `PublishOutcome` this bookkeeping actually reads. */
export interface PublishRecord {
  snapshotId: string
  committed: boolean
  buildTriggered: boolean
}

/**
 * True when the site is serving a version this vault deliberately made live
 * rather than the latest publish.
 *
 * One-shot, not a pin: this blocks nothing. It exists because every real
 * rollback ends the same way (roll back, fix the note or the rule, publish
 * forward), and the middle step is where somebody needs reminding that what
 * they are looking at online is not what their vault holds.
 */
export function isRolledBack(settings: Settings): boolean {
  return settings.lastRollback !== null
}

export const ROLLBACK_HEADLINE = 'Your site is showing an older version.'

/** The panel's body, naming the version, or null when nothing is rolled back. */
export function rollbackWarning(settings: Settings): string | null {
  const rollback = settings.lastRollback
  if (!rollback) return null
  // The ID carries the version's own publish time, so the panel can name the
  // version rather than the moment somebody clicked, which is the thing they
  // would recognise. `at` is the fallback for an ID from some future scheme.
  const when = snapshotTime(rollback.to) ?? rollback.at
  const stamp = when ? new Date(when).toLocaleString() : rollback.to
  return (
    `You made the ${stamp} version live again. Your notes have moved on since then. ` +
    'Publishing takes the site forward.'
  )
}

export const HOST_MOVED_WARNING =
  'Your site is still being served by the host you last published to. This host has to build once before ' +
  "anything here goes live, and it needs the same variables as the old one. Step 4 of the setup guide has them."

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.replace(/^\/+|\/+$/g, ''))
}

function asBooleanRecord(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'boolean') out[key] = entry
  }
  return out
}

/**
 * Every field a request needs, on the destination alone.
 *
 * A reference is checked for being *set*, never for resolving. Whether the
 * keychain still holds an entry by that name is a question only `main.ts` can
 * ask, because asking it needs `app`, and this file imports nothing from
 * Obsidian so that its tests can run under plain Node with no stub. That
 * boundary is worth more than the slightly earlier warning it costs: the
 * missing-entry case is reported at resolution time, in a sentence, by
 * `destination()`.
 */
export function isDestinationReady(destination: DestinationSettings): boolean {
  if (destination.type === 'gateway') return Boolean(destination.workerUrl && destination.tokenRef)
  return Boolean(destination.endpoint && destination.bucket && destination.accessKeyId && destination.secretRef)
}

export function isDestinationConfigured(settings: Settings): boolean {
  return isDestinationReady(settings.destination)
}

/**
 * Which keychain entry this destination's credential lives in, whichever kind
 * it is.
 *
 * Here rather than in `main.ts` so that the two questions asked about that name
 * cannot drift apart: "can this device resolve it" before a window opens, and
 * "resolve it" when a request is about to be signed. Both are `main.ts`'s to
 * ask, because both need `app`; which field holds the name is this file's to
 * answer, because the shape is.
 */
export function secretRefOf(destination: DestinationSettings): string {
  return destination.type === 'gateway' ? destination.tokenRef : destination.secretRef
}

/** Enough to start a build. */
export function isHookConfigured(settings: Settings): boolean {
  return Boolean(settings.builder.url)
}

/** Enough to start a build *and* tell when it landed, on the builder alone. */
export function isBuilderReady(builder: WebhookBuilderSettings): boolean {
  return Boolean(builder.url && builder.siteUrl)
}

export function isBuilderConfigured(settings: Settings): boolean {
  return isBuilderReady(settings.builder)
}
