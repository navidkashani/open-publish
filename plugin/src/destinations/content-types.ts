/**
 * Extension -> MIME type.
 *
 * Its own module so that the publisher can label uploads without importing
 * the whole S3 client.
 */

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', '3gp': 'audio/3gpp',
  mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  pdf: 'application/pdf',
  canvas: 'application/json',
}

export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}
