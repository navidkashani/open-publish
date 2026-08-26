/**
 * The storage catalogue: presentation and prefill, and nothing else.
 *
 * The rule this file lives by is that **none of it reaches the wire**.
 * `S3Destination` keeps receiving the same `S3Config` it always has, and the
 * endpoint string stays the only source of truth for what gets signed and sent.
 * A provider id is a label, a set of instructions, and a way to fill in four
 * fields instead of seven. The system stays fully correct if that id is
 * missing, stale, or flatly wrong, which is what makes adding it cheap.
 *
 * That is also why the variable value (an account ID, a region) is never
 * stored: it is parsed back out of the endpoint whenever the UI needs it, so
 * the two cannot drift apart. There is one source of truth, and it is the one
 * the request uses.
 *
 * No imports on purpose. This is a table plus three pure functions, so it runs
 * under plain Node and the tests need no DOM, no Obsidian, and no network.
 */

export type ProviderId = 'r2' | 'aws' | 'b2' | 'wasabi' | 'minio' | 'other'

/**
 * What we expect `Test connection` to find. It is an expectation, never a
 * claim: the runtime check is the authority, and it is allowed to disagree.
 */
export type ConcurrencyExpectation = 'safe' | 'unconfirmed'

export interface ProviderVariable {
  /** The one blank this provider asks for. */
  label: string
  placeholder: string
  help: string
  /** How the docs table writes this blank, e.g. `account-id`. */
  docsToken: string
  /** Checked on blur, never while typing. */
  pattern: RegExp
  error: string
  /** True when this value is also the signing region. */
  isRegion?: boolean
}

export interface StorageProvider {
  id: ProviderId
  name: string
  /** One line: what this is, and what it costs. */
  summary: string
  /** The two-device sentence. The same words in the picker, the wizard and settings. */
  concurrency: string
  expects: ConcurrencyExpectation
  recommended?: boolean
  /** Shown wherever this provider is chosen, not only where it is picked. */
  caution?: string
  /** `{v}` is the one blank. Null means the user types the endpoint themselves. */
  endpointTemplate: string | null
  variable: ProviderVariable
  /** The signing region when it is not the variable. Null leaves it to the user. */
  fixedRegion: string | null
  forcePathStyle: boolean
  consoleUrl?: string
  keysUrl?: string
  /** Step 1 of the setup guide, in this provider's own words. */
  setup: string[]
  /** Appended to "bucket not found", which used to name R2 at every provider. */
  missingBucketHint: string
}

const REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d+$/
const ADDRESS_PATTERN = /^https?:\/\/\S+$/i
const ADDRESS_ERROR = 'An address has to start with https:// or http://.'

/**
 * Order matters twice: it is the order of the picker, and R2 leads because it
 * is the one we recommend.
 *
 * Wasabi is listed rather than left out. Omitting it does not stop anyone using
 * it; it only means they type it into "Other" and meet the 90-day deletion
 * charge with no warning at all.
 */
export const PROVIDERS: readonly StorageProvider[] = [
  {
    id: 'r2',
    name: 'Cloudflare R2',
    summary: 'Free for the first 10 GB, and downloads are free.',
    concurrency: 'Two devices can publish safely.',
    expects: 'safe',
    recommended: true,
    endpointTemplate: 'https://{v}.r2.cloudflarestorage.com',
    variable: {
      label: 'Account ID',
      placeholder: '0123456789abcdef0123456789abcdef',
      help: 'From the R2 overview page. Not your zone ID, and not your user ID.',
      docsToken: 'account-id',
      pattern: /^[0-9a-f]{32}$/i,
      error: "That doesn't look like an account ID. It should be 32 letters and numbers from the R2 overview page.",
    },
    fixedRegion: 'auto',
    forcePathStyle: true,
    consoleUrl: 'https://dash.cloudflare.com/?to=/:account/r2',
    keysUrl: 'https://developers.cloudflare.com/r2/api/tokens/',
    setup: [
      'Open the Cloudflare dashboard and go to R2.',
      'Create a bucket. "my-notes-publish" is a fine name. Leave it private.',
      'Note your Account ID from the R2 overview page. You will paste it on the next step.',
      'Go to R2 API Tokens and create a token with Object Read & Write, scoped to this bucket only. Save the key and secret.',
      'Create a second token with Object Read only, scoped to the same bucket. That one goes to the build in a later step.',
    ],
    missingBucketHint:
      'Check the bucket name, and that the endpoint holds the right account ID from the R2 overview page.',
  },
  {
    id: 'aws',
    name: 'Amazon S3',
    summary: 'Pay for what you use, in a region you choose.',
    concurrency: 'Two devices can publish safely.',
    expects: 'safe',
    endpointTemplate: 'https://s3.{v}.amazonaws.com',
    variable: {
      label: 'Region',
      placeholder: 'eu-west-1',
      help: "The region the bucket lives in. It is on the bucket's page in the S3 console.",
      docsToken: 'region',
      pattern: REGION_PATTERN,
      error: "That doesn't look like a region. It should look like eu-west-1.",
      isRegion: true,
    },
    fixedRegion: null,
    // The one provider that is not path-style. AWS documents path-style as
    // deprecated, and virtual-host addressing is the form they are keeping.
    // The cost is that a bucket name containing a dot breaks TLS, which is why
    // AWS discourages those names in the first place.
    forcePathStyle: false,
    consoleUrl: 'https://console.aws.amazon.com/s3',
    keysUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html',
    setup: [
      'Open the S3 console and create a bucket. Note the region you create it in, and avoid dots in the name.',
      'Create an IAM user for the plugin, with no console access.',
      'Give that user a policy with s3:ListBucket on the bucket, and s3:GetObject, s3:PutObject and s3:DeleteObject on everything inside it.',
      'Create an access key for that user. Save the key ID and secret.',
      'Create a second user with s3:ListBucket and s3:GetObject only. That one goes to the build in a later step.',
    ],
    missingBucketHint: "Check the bucket name, and that the region in the endpoint is the bucket's own region.",
  },
  {
    id: 'b2',
    name: 'Backblaze B2',
    summary: 'Low-cost storage that speaks the S3 API.',
    // Backblaze's own documentation does not state conditional-write support
    // either way, so this promises nothing and lets the connection test answer.
    concurrency: 'We check two-device safety when you connect.',
    expects: 'unconfirmed',
    endpointTemplate: 'https://s3.{v}.backblazeb2.com',
    variable: {
      label: 'Region',
      placeholder: 'us-west-004',
      help: 'The middle part of the endpoint Backblaze shows on your bucket.',
      docsToken: 'region',
      pattern: REGION_PATTERN,
      error: "That doesn't look like a region. It should look like us-west-004.",
      isRegion: true,
    },
    fixedRegion: null,
    forcePathStyle: true,
    consoleUrl: 'https://secure.backblaze.com',
    keysUrl: 'https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys',
    setup: [
      'Sign in to Backblaze and create a bucket. Keep it private.',
      'Note the S3 endpoint shown on the bucket, e.g. s3.us-west-004.backblazeb2.com. The middle part is your region.',
      'Go to Application Keys and create a key limited to this bucket, with read and write access.',
      'Create a second key with read-only access to the same bucket. That one goes to the build in a later step.',
    ],
    missingBucketHint: 'Check the bucket name, and that the region in the endpoint matches the one on your bucket.',
  },
  {
    id: 'wasabi',
    name: 'Wasabi',
    summary: 'Flat-rate storage.',
    concurrency: 'We check two-device safety when you connect.',
    expects: 'unconfirmed',
    caution:
      'Wasabi bills every object for 90 days even if you delete it sooner, so "Clean up unused files" costs money here.',
    endpointTemplate: 'https://s3.{v}.wasabisys.com',
    variable: {
      label: 'Region',
      placeholder: 'eu-central-1',
      help: 'The region your bucket lives in.',
      docsToken: 'region',
      pattern: REGION_PATTERN,
      error: "That doesn't look like a region. It should look like eu-central-1.",
      isRegion: true,
    },
    fixedRegion: null,
    forcePathStyle: true,
    consoleUrl: 'https://console.wasabisys.com',
    setup: [
      'Sign in to the Wasabi console and create a bucket. Note its region.',
      'Go to Access Keys and create a key pair with read and write access.',
      'Create a second, read-only key pair. That one goes to the build in a later step.',
      'Worth knowing before you start: deleting an object inside 90 days still bills for the rest of the 90 days.',
    ],
    missingBucketHint: 'Check the bucket name, and that the region in the endpoint matches the one on your bucket.',
  },
  {
    id: 'minio',
    name: 'MinIO',
    summary: 'Storage you run yourself.',
    concurrency: 'Recent versions let two devices publish safely.',
    expects: 'unconfirmed',
    endpointTemplate: null,
    variable: {
      label: 'Server address',
      placeholder: 'http://localhost:9000',
      help: 'Where your MinIO server answers, including http:// or https://.',
      docsToken: 'server-url',
      pattern: ADDRESS_PATTERN,
      error: ADDRESS_ERROR,
    },
    fixedRegion: 'us-east-1',
    forcePathStyle: true,
    setup: [
      'Start MinIO, or open the console of a server you already run.',
      'Create a bucket. Leave it private.',
      'Create a service account, or use the root credentials on a server only you can reach.',
      'Note the server address, e.g. http://localhost:9000. You will paste it on the next step.',
      'MinIO releases from before September 2024 have a conditional-write bug. Run the storage self-test afterwards if yours is older.',
    ],
    missingBucketHint: 'Check the bucket name, and that the bucket exists on this server.',
  },
  {
    id: 'other',
    name: 'Other S3-compatible storage',
    summary: 'Anything that speaks the S3 API.',
    concurrency: 'We check what it can do when you connect.',
    expects: 'unconfirmed',
    endpointTemplate: null,
    variable: {
      label: 'Endpoint',
      placeholder: 'https://storage.example.com',
      help: "Your provider's S3 API endpoint, including https://.",
      docsToken: 'endpoint',
      pattern: ADDRESS_PATTERN,
      error: ADDRESS_ERROR,
    },
    fixedRegion: null,
    forcePathStyle: true,
    setup: [
      'Create a private bucket with your provider.',
      'Find its S3 API endpoint. It is a full URL, not a hostname on its own.',
      'Create credentials with read and write access to that bucket.',
      'Create a second, read-only pair if your provider allows it. That one goes to the build in a later step.',
      'Use Test connection on the next step. It reports what this storage can actually do, rather than what it claims.',
    ],
    missingBucketHint: 'Check the bucket name and the endpoint URL.',
  },
]

const FALLBACK = PROVIDERS[PROVIDERS.length - 1] as StorageProvider

/** Never throws. An id we do not know is a label problem, not a publish problem. */
export function providerById(id: string | undefined): StorageProvider {
  return PROVIDERS.find((provider) => provider.id === id) ?? FALLBACK
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.some((provider) => provider.id === value)
}

/** True when the user types the whole endpoint rather than one blank in it. */
export function isFreeForm(id: string | undefined): boolean {
  return providerById(id).endpointTemplate === null
}

/**
 * The endpoint this provider builds from its one blank.
 *
 * An empty blank gives an empty endpoint, never a half-built URL: a bucket at
 * `https://.r2.cloudflarestorage.com` would look configured to every check we
 * have, and fail at the first request.
 */
export function composeEndpoint(id: string | undefined, value: string): string {
  const provider = providerById(id)
  const trimmed = value.trim().replace(/\/+$/, '')
  if (provider.endpointTemplate === null) return trimmed
  if (!trimmed) return ''
  return provider.endpointTemplate.replace('{v}', trimmed)
}

/**
 * Anchored, and deliberately strict about what a blank may contain.
 *
 * Excluding dots is what keeps the templates from overlapping (an AWS endpoint
 * cannot pose as an R2 account ID), and anchoring at the end is what stops
 * `https://acct.r2.cloudflarestorage.com.attacker.net` from being labelled
 * Cloudflare and shown a Cloudflare link.
 */
function templatePattern(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace('\\{v\\}', '([A-Za-z0-9][A-Za-z0-9-]*)')}$`, 'i')
}

/**
 * Which provider an endpoint belongs to, by exact template match only.
 *
 * Everything else is "Other", including a custom domain in front of a bucket we
 * would otherwise recognise. That is the point: inference is read-only, so a
 * near miss costs a label, never a rewritten configuration.
 */
export function inferProvider(endpoint: string | undefined): { id: ProviderId; value: string } {
  const cleaned = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!cleaned) return { id: 'other', value: '' }
  for (const provider of PROVIDERS) {
    if (provider.endpointTemplate === null) continue
    const match = templatePattern(provider.endpointTemplate).exec(cleaned)
    if (match) return { id: provider.id, value: match[1] as string }
  }
  return { id: 'other', value: cleaned }
}

/** The blank's current value, read back out of the endpoint rather than stored. */
export function variableValue(id: string | undefined, endpoint: string): string {
  const provider = providerById(id)
  if (provider.endpointTemplate === null) return endpoint
  const inferred = inferProvider(endpoint)
  return inferred.id === provider.id ? inferred.value : ''
}

export interface ProviderTarget {
  provider: ProviderId
  endpoint: string
  region: string
  forcePathStyle: boolean
}

/**
 * What changes when someone picks a different provider.
 *
 * Bucket, prefix and credentials are untouched, and never appear here: they are
 * the parts that a provider switch has no opinion about.
 *
 * A free-form provider keeps whatever endpoint is already there, because there
 * is no template that could disagree with it. A templated one carries the blank
 * over only when the endpoint already belongs to that same provider, since an
 * account ID is not a region and pretending otherwise builds a URL that looks
 * plausible and resolves nowhere.
 */
export function applyProvider(current: ProviderTarget, id: ProviderId): ProviderTarget {
  if (current.provider === id) return current
  const provider = providerById(id)
  const carried = provider.endpointTemplate === null ? current.endpoint : variableValue(id, current.endpoint)
  const endpoint = composeEndpoint(id, carried)
  const region = provider.variable.isRegion
    ? variableValue(id, endpoint)
    : (provider.fixedRegion ?? current.region)
  return { provider: id, endpoint, region: region || 'auto', forcePathStyle: provider.forcePathStyle }
}

/** How the docs table writes this provider's endpoint. Kept in step by a test. */
export function docsEndpoint(id: ProviderId): string | null {
  const provider = providerById(id)
  if (provider.endpointTemplate === null) return null
  return provider.endpointTemplate.replace('{v}', `<${provider.variable.docsToken}>`)
}

/**
 * The hint for a bucket that was not found, in terms of the provider actually
 * in use. It used to tell every user to check their R2 account ID, including
 * the ones who had never heard of R2.
 */
export function missingBucketHint(endpoint: string | undefined): string {
  return providerById(inferProvider(endpoint).id).missingBucketHint
}

// --- Advanced ------------------------------------------------------------

export interface AdvancedFields {
  endpoint: string
  region: string
  prefix?: string
  forcePathStyle?: boolean
}

/**
 * Which of the fields behind "Advanced" hold something other than this
 * provider's default, in words.
 *
 * This is what decides whether Advanced starts open. The rule is that nothing
 * the user chose is ever hidden behind a closed section, because a prefilled
 * value nobody can see is worse than one more row on the screen.
 */
export function advancedChanges(id: string | undefined, fields: AdvancedFields): string[] {
  const provider = providerById(id)
  const changes: string[] = []

  if (provider.endpointTemplate !== null) {
    const composed = composeEndpoint(id, variableValue(id, fields.endpoint))
    if (fields.endpoint.replace(/\/+$/, '') !== composed) changes.push('custom endpoint')
  }
  if (provider.variable.isRegion) {
    // The region *is* the blank on these, so it is normally not an advanced
    // field at all. It becomes one when it disagrees with the endpoint, which
    // signs every request for the wrong region and reads back as rejected
    // credentials. Reporting it is what stops that being invisible.
    const derived = variableValue(id, fields.endpoint)
    if (derived && (fields.region || 'auto') !== derived) changes.push(`region "${fields.region}"`)
  } else {
    const expected = provider.fixedRegion ?? 'auto'
    if ((fields.region || 'auto') !== expected) changes.push(`region "${fields.region}"`)
  }
  const prefix = (fields.prefix ?? '').replace(/^\/+|\/+$/g, '')
  if (prefix) changes.push(`key prefix "${prefix}"`)
  if ((fields.forcePathStyle !== false) !== provider.forcePathStyle) {
    changes.push(provider.forcePathStyle ? 'path-style off' : 'path-style on')
  }
  return changes
}
