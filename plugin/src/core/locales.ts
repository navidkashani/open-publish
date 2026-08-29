/**
 * The languages the plugin can publish, and the reading direction each implies.
 *
 * Seeded from the set Quartz ships translations for, because a tag no starter
 * can render is a tag that produces an English site with a foreign `lang`
 * attribute, which is worse than not offering it. This is the plugin's list, not
 * Quartz's: a starter that supports more is free to, and adding one here is a
 * one-line change.
 *
 * Closed rather than free text on purpose. A fixed list of 28 region-qualified
 * tags makes `directionFor` an exact, hand-checkable lookup instead of a script
 * detection heuristic, and there are exactly two RTL entries to check.
 *
 * No Obsidian import: this module is unit tested under plain Node.
 */

export interface LocaleOption {
  /** BCP-47 tag, region-qualified: `fa-IR`, not `fa`. */
  tag: string
  /** What the settings dropdown and the rollback diff call it. */
  label: string
  dir: 'ltr' | 'rtl'
}

/**
 * What a site gets when nothing has said otherwise: today's hardcoded
 * behaviour, so an existing vault publishes the same site it always did.
 *
 * Also what a snapshot written before these fields existed is read as, which is
 * why it is exported: `diffSiteOptions` has to compare a missing `locale`
 * against something, and comparing it against `undefined` would announce a
 * language change on every rollback across this upgrade.
 */
export const DEFAULT_LOCALE = 'en-US'

/** Ordered by tag, so the two RTL entries stay easy to find and verify. */
export const LOCALES: readonly LocaleOption[] = [
  { tag: 'ar-SA', label: 'Arabic (Saudi Arabia)', dir: 'rtl' },
  { tag: 'ca-ES', label: 'Catalan (Spain)', dir: 'ltr' },
  { tag: 'cs-CZ', label: 'Czech (Czechia)', dir: 'ltr' },
  { tag: 'de-DE', label: 'German (Germany)', dir: 'ltr' },
  { tag: 'en-GB', label: 'English (United Kingdom)', dir: 'ltr' },
  { tag: 'en-US', label: 'English (United States)', dir: 'ltr' },
  { tag: 'es-ES', label: 'Spanish (Spain)', dir: 'ltr' },
  { tag: 'fa-IR', label: 'Persian (Iran)', dir: 'rtl' },
  { tag: 'fi-FI', label: 'Finnish (Finland)', dir: 'ltr' },
  { tag: 'fr-FR', label: 'French (France)', dir: 'ltr' },
  { tag: 'hu-HU', label: 'Hungarian (Hungary)', dir: 'ltr' },
  { tag: 'id-ID', label: 'Indonesian (Indonesia)', dir: 'ltr' },
  { tag: 'it-IT', label: 'Italian (Italy)', dir: 'ltr' },
  { tag: 'ja-JP', label: 'Japanese (Japan)', dir: 'ltr' },
  { tag: 'ko-KR', label: 'Korean (South Korea)', dir: 'ltr' },
  { tag: 'lt-LT', label: 'Lithuanian (Lithuania)', dir: 'ltr' },
  { tag: 'nb-NO', label: 'Norwegian Bokmal (Norway)', dir: 'ltr' },
  { tag: 'nl-NL', label: 'Dutch (Netherlands)', dir: 'ltr' },
  { tag: 'pl-PL', label: 'Polish (Poland)', dir: 'ltr' },
  { tag: 'pt-BR', label: 'Portuguese (Brazil)', dir: 'ltr' },
  { tag: 'ro-RO', label: 'Romanian (Romania)', dir: 'ltr' },
  { tag: 'ru-RU', label: 'Russian (Russia)', dir: 'ltr' },
  { tag: 'th-TH', label: 'Thai (Thailand)', dir: 'ltr' },
  { tag: 'tr-TR', label: 'Turkish (Turkiye)', dir: 'ltr' },
  { tag: 'uk-UA', label: 'Ukrainian (Ukraine)', dir: 'ltr' },
  { tag: 'vi-VN', label: 'Vietnamese (Vietnam)', dir: 'ltr' },
  { tag: 'zh-CN', label: 'Chinese (Simplified, China)', dir: 'ltr' },
  { tag: 'zh-TW', label: 'Chinese (Traditional, Taiwan)', dir: 'ltr' },
]

const BY_TAG = new Map(LOCALES.map((locale) => [locale.tag, locale]))

/** Is this one of the tags above? The guard `migrateSettings` validates with. */
export function isLocale(value: unknown): value is string {
  return typeof value === 'string' && BY_TAG.has(value)
}

/**
 * The reading direction a language implies.
 *
 * `ltr` for anything unrecognised: the safe default, and unreachable in
 * practice because `locale` is validated against the table on load.
 */
export function directionFor(tag: string): 'ltr' | 'rtl' {
  return BY_TAG.get(tag)?.dir ?? 'ltr'
}

/**
 * A tag as a person would read it, falling back to the tag itself.
 *
 * The fallback is for snapshots rather than settings: a manifest written by a
 * newer plugin, read back by this one during a rollback, can name a language
 * this build has never heard of, and `"fa-IR" -> "sv-SE"` is still a useful
 * thing to be told.
 */
export function localeLabel(tag: string): string {
  return BY_TAG.get(tag)?.label ?? tag
}
