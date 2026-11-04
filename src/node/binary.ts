/**
 * Buffer/encoding plumbing shared by every shim. The `buffer` npm package is a
 * faithful `Buffer` (a `Uint8Array` subclass), so code doing
 * `Buffer.isBuffer(x)`, `buf.toString('utf8')`, or `Buffer.concat` behaves as it
 * does on Node.
 */

import { Buffer } from 'buffer'

/**
 * `base64url`, which the `buffer` polyfill stops short of.
 *
 * Node has accepted this encoding since v15 and published packages use it for
 * anything that travels in a URL or a JSON field — a plugin's transfer nonce,
 * an HMAC secret. The polyfill knows `base64` only, so `buf.toString('base64url')`
 * throws `Unknown encoding` from inside a dependency that has no idea it is in a
 * browser. Two small wrappers make it behave like Node's: decode is the standard
 * alphabet plus padding, encode is the standard alphabet minus padding.
 */
const originalFrom = Buffer.from.bind(Buffer) as typeof Buffer.from
const originalToString = Buffer.prototype.toString
const originalIsEncoding = Buffer.isEncoding.bind(Buffer)

/** The URL-safe alphabet, translated back to the standard one for decoding. */
const toStandardBase64 = (value: string): string => value.replace(/-/g, '+').replace(/_/g, '/')

/**
 * `Buffer.from(value, 'base64url')` and the matching `toString`.
 * @param value - what to construct from.
 * @param encodingOrOffset - an encoding name, or a byte offset.
 * @param length - the byte length, when an offset was given.
 * @returns the buffer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Buffer as any).from = (value: any, encodingOrOffset?: any, length?: any): Buffer => {
  if (typeof value === 'string' && String(encodingOrOffset).toLowerCase() === 'base64url') {
    const standard = toStandardBase64(value)
    return (originalFrom as any)(standard + '='.repeat((4 - (standard.length % 4)) % 4), 'base64')
  }
  return (originalFrom as any)(value, encodingOrOffset, length)
}

/** `buf.toString('base64url')`, and everything else, unchanged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Buffer.prototype as any).toString = function patchedToString(this: Buffer, encoding?: any, start?: any, end?: any): string {
  if (typeof encoding === 'string' && encoding.toLowerCase() === 'base64url') {
    return originalToString.call(this, 'base64' as BufferEncoding)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  }
  return originalToString.call(this, encoding, start, end)
}

/** `base64url` is a real encoding here, so `StringDecoder` and friends accept it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Buffer as any).isEncoding = (encoding: string): boolean =>
  String(encoding).toLowerCase() === 'base64url' ? true : originalIsEncoding(encoding as BufferEncoding)

export { Buffer }

/** Everything Node accepts where "file contents" are expected. */
export type BinaryLike = string | Uint8Array | ArrayBuffer | ArrayBufferView

/** Encodings the shims decode; anything else falls back to utf8. */
export type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'binary' | 'base64' | 'base64url' | 'hex' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le'

const encoder = new TextEncoder()

/**
 * Coerce any Node-accepted payload into raw bytes.
 * @param data - the payload.
 * @param encoding - how to decode a string payload (default utf8).
 * @returns a `Uint8Array` view over the bytes.
 */
export function toBytes(data: BinaryLike, encoding: Encoding | string = 'utf8'): Uint8Array {
  if (typeof data === 'string') {
    return encoding === 'utf8' || encoding === 'utf-8'
      ? encoder.encode(data)
      : new Uint8Array(Buffer.from(data, encoding as BufferEncoding))
  }
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * Decode bytes with a Node encoding name.
 * @param bytes - the source bytes.
 * @param encoding - the target encoding.
 * @returns the decoded string.
 */
export function toText(bytes: Uint8Array, encoding: Encoding | string = 'utf8'): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(encoding as BufferEncoding)
}

/** Wrap bytes in a `Buffer` without copying. */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * Normalize Node's `(options | encoding)` argument pattern.
 * @param options - a string encoding, an options object, or nullish.
 * @returns the options object with `encoding` resolved.
 */
export function readOptions(
  options: unknown,
): { encoding?: string, flag?: string, mode?: number, recursive?: boolean, withFileTypes?: boolean, force?: boolean } {
  if (typeof options === 'string') return { encoding: options }
  if (typeof options === 'object' && options !== null) return options as Record<string, never>
  return {}
}
