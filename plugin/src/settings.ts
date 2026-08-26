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
import { inferProvider, isProviderId } from './destinations/providers.ts'
import type { ProviderId } from './destinations/providers.ts'
import { inferHost, isHostId } from './builders/hosts.ts'
import type { HostId } from './builders/hosts.ts'
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

export interface Settings {
  version: number
  /**
   * `provider` sits *beside* `type`, not in place of it. `type` is the
   * destination-kind discriminant a future Git destination would need; R2, B2
   * and Wasabi are all `type: 's3'`, same config and same code path. The
   * provider is a label and a set of prefills, and `S3Destination` never sees
   * it.
   */
  destination: S3Config & { type: 's3'; provider: ProviderId }
  builder: WebhookBuilderSettings
  selection: SelectionSettings
  site: SnapshotSite
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
    secretAccessKey: '',
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
  lastSnapshotId: null,
  lastPublishedAt: null,
  lastBuildTriggeredAt: null,
  lastPublishedTarget: null,
  lastPublishedHostTarget: null,
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

  if (stored.destination) Object.assign(settings.destination, stored.destination, { type: 's3' })
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
  }

  settings.destination.provider = resolveProvider(stored.destination)
  settings.builder.host = resolveHost(stored.builder)

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
  settings.version = SETTINGS_VERSION
  return settings
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
function resolveProvider(stored: Partial<S3Config & { provider?: unknown }> | undefined): ProviderId {
  if (isProviderId(stored?.provider)) return stored.provider
  const endpoint = typeof stored?.endpoint === 'string' ? stored.endpoint : ''
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
export function storageTarget(destination: Pick<S3Config, 'endpoint' | 'bucket' | 'prefix' | 'forcePathStyle'>): string {
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

/** Every field a request needs, on the destination alone. */
export function isDestinationReady(destination: S3Config): boolean {
  return Boolean(
    destination.endpoint && destination.bucket && destination.accessKeyId && destination.secretAccessKey,
  )
}

export function isDestinationConfigured(settings: Settings): boolean {
  return isDestinationReady(settings.destination)
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
