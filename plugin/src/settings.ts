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
import type { SnapshotSite } from './core/snapshot.ts'

export const SETTINGS_VERSION = 1

export interface WebhookBuilderSettings {
  type: 'webhook'
  url: string
  method: 'POST' | 'GET'
  siteUrl: string
  logsUrl: string
  autoTrigger: boolean
  /** Free-tier builds are scarce (Pages: 500/month, 1 concurrent). */
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
  destination: S3Config & { type: 's3' }
  builder: WebhookBuilderSettings
  selection: SelectionSettings
  site: SnapshotSite
  lastSnapshotId: string | null
  lastPublishedAt: number | null
  /** Drives build throttling; separate from lastPublishedAt because a publish can skip the build. */
  lastBuildTriggeredAt: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  destination: {
    type: 's3',
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

  settings.lastSnapshotId = typeof stored.lastSnapshotId === 'string' ? stored.lastSnapshotId : null
  settings.lastPublishedAt = typeof stored.lastPublishedAt === 'number' ? stored.lastPublishedAt : null
  settings.lastBuildTriggeredAt =
    typeof stored.lastBuildTriggeredAt === 'number' ? stored.lastBuildTriggeredAt : null
  settings.version = SETTINGS_VERSION
  return settings
}

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

export function isDestinationConfigured(settings: Settings): boolean {
  const d = settings.destination
  return Boolean(d.endpoint && d.bucket && d.accessKeyId && d.secretAccessKey)
}

/** Enough to start a build. */
export function isHookConfigured(settings: Settings): boolean {
  return Boolean(settings.builder.url)
}

/** Enough to start a build *and* tell when it landed. */
export function isBuilderConfigured(settings: Settings): boolean {
  return Boolean(settings.builder.url && settings.builder.siteUrl)
}
