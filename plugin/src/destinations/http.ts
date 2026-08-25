/**
 * The one HTTP seam in the plugin.
 *
 * Everything network-facing goes through this interface so that (a) the S3
 * client and the webhook builder can be unit tested against a fake transport
 * with no Obsidian present, and (b) there is exactly one place that knows we
 * use `requestUrl` rather than `fetch`.
 *
 * Why `requestUrl` and never `fetch` (design note 2.3): it bypasses CORS
 * entirely, so users never have to configure a bucket CORS policy — one whole
 * onboarding step and a large class of support tickets deleted. The cost is no
 * streaming and no multipart, which is why the size limits in `limits.ts` exist.
 */

export interface HttpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: ArrayBuffer | string
  contentType?: string
}

export interface HttpResponse {
  /** 0 means the request never reached a server. */
  status: number
  headers: Record<string, string>
  arrayBuffer: ArrayBuffer
  text: string
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>

/** Case-insensitive header lookup — transports disagree about casing. */
export function header(response: HttpResponse, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/** ETags come back quoted, sometimes with a `W/` prefix. Compare them normalised. */
export function normalizeEtag(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/^W\//, '').replace(/^"|"$/g, '')
}
