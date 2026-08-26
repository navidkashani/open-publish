/**
 * The only file that knows we use Obsidian's `requestUrl`.
 *
 * `requestUrl` bypasses CORS, which means users never configure a bucket CORS
 * policy: one whole onboarding step deleted. It also works on mobile, unlike
 * anything Node-based. Its limitation (no streaming, whole body in memory) is
 * what the size limits in core/limits.ts exist to contain.
 */

import { requestUrl } from 'obsidian'
import type { RequestUrlResponse } from 'obsidian'
import type { HttpClient, HttpResponse } from './http.ts'

export function obsidianHttp(): HttpClient {
  return async (request) => {
    let response: RequestUrlResponse
    try {
      response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        contentType: request.contentType,
        // We map statuses onto our own error table, so never let requestUrl throw
        // on a non-2xx: a 404 from HEAD is a normal, expected answer here.
        throw: false,
      })
    } catch (error) {
      // A thrown error means the request never reached a server at all.
      return {
        status: 0,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: error instanceof Error ? error.message : String(error),
      }
    }

    return toHttpResponse(response)
  }
}

function toHttpResponse(response: RequestUrlResponse): HttpResponse {
  const arrayBuffer = response.arrayBuffer ?? new ArrayBuffer(0)
  // `response.text` on a binary body can throw or produce garbage; we only ever
  // need the text form for XML error bodies, which are small and UTF-8.
  let text = ''
  try {
    text = arrayBuffer.byteLength > 0 && arrayBuffer.byteLength < 1_000_000
      ? new TextDecoder().decode(arrayBuffer)
      : ''
  } catch {
    text = ''
  }

  return {
    status: response.status,
    headers: response.headers ?? {},
    arrayBuffer,
    text,
  }
}
