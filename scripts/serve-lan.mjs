/**
 * 局域网静态服务器 —— 在 `scripts/serve.mjs` 的基础上做三处改动，专供局域网使用：
 *
 * 1. 绑 `0.0.0.0`（默认端口 4173），同网段任何设备都能开。
 * 2. 给带内容哈希的目录（`/assets/`、`/shell/`、`/plugins/`、`/v86/`、`/market/`）
 *    发 `immutable` 长缓存；`index.html` / `sw.js` 发 `no-cache`。
 *    上游那份是全部 `no-store`，每次刷新都要重下 24MB 的 assets。
 * 3. 保持 COOP/COEP/CORP，让页面在局域网里也是 cross-origin isolated
 *    （`SharedArrayBuffer` 与容器运行时需要）。
 *
 * 保留 `serve.mjs` 的两条约定：只对导航回落 index.html（插件注册的 HTTP 路由
 * 依赖 404 才生效）、以及按 Range 读取以支持 v86 的流式磁盘。
 *
 * 用法:
 *   node scripts/serve-lan.mjs [port] [host]            # 明文 HTTP，任何设备可开
 *   WEBSH_TLS_CERT=... WEBSH_TLS_KEY=... node scripts/serve-lan.mjs [port] [host]
 *                                                       # HTTPS；端口 4443 起，
 *                                                       # 证书由 ~/webdsh-deploy/tls 生成本地 CA
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { constants as zlibConstants, brotliCompressSync, gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// WEBSH_ROOT lets a second instance serve another build (A/B measurements).
const root = process.env.WEBSH_ROOT ?? fileURLToPath(new URL('../dist/', import.meta.url))
const port = Number(process.argv[2] ?? 4173)
const host = process.argv[3] ?? '0.0.0.0'

/** Content types for the file kinds this build emits. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.bin': 'application/octet-stream',
  '.zst': 'application/octet-stream',
}

/** Paths that carry a content hash in the file name and never change. */
const IMMUTABLE = ['/assets/', '/shell/', '/plugins/', '/v86/', '/market/']

/**
 * Compressible kinds. `dist/` is written uncompressed (18.8 MB of JS on the
 * wire here), which is fine over a cable and not fine over the hotspot this
 * Mac is usually on — a phone pulling 18.8 MB is the difference between a few
 * seconds and half a minute.
 */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.wasm', '.map', '.txt'])

/** Brotli results keyed by file + mtime; the build does not change under a running server. */
const compressed = new Map()

/**
 * Off by default. On this LAN the wire is ~78 MB/s (18.8 MB of assets in
 * 0.15s), so compressing costs more CPU — synchronously, blocking the loop —
 * than the bytes it saves. Turn it on for a slow/far client:
 *   WEBSH_COMPRESS=1 node scripts/serve-lan.mjs 4173
 */
const COMPRESS = process.env.WEBSH_COMPRESS === '1'

const isolation = {
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'cross-origin',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges, etag, last-modified',
}

const certPath = process.env.WEBSH_TLS_CERT
const keyPath = process.env.WEBSH_TLS_KEY
const handler = (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  let file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  const wantsDocument = (req.headers.accept ?? '').includes('text/html')
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (!wantsDocument) {
      res.writeHead(404, { ...isolation, 'cache-control': 'no-store' })
      res.end('not found')
      return
    }
    file = join(root, 'index.html')
  }
  if (!existsSync(file)) {
    res.writeHead(404)
    res.end('not found')
    return
  }

  const stats = statSync(file)
  const immutable = IMMUTABLE.some((prefix) => pathname.startsWith(prefix))
  const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`
  const common = {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'last-modified': stats.mtime.toUTCString(),
    etag,
    ...isolation,
  }

  // A conditional reload is answered without touching the body.
  if ((req.headers['if-none-match'] ?? '') === etag) {
    res.writeHead(304, common)
    res.end()
    return
  }

  // Range and compression do not mix: the VM's disk is read by byte offset, and
  // a compressed body has no stable offsets.
  const accept = String(req.headers['accept-encoding'] ?? '')
  const encoding = COMPRESS && COMPRESSIBLE.has(extname(file)) && req.headers.range === undefined
    ? accept.includes('br') ? 'br' : accept.includes('gzip') ? 'gzip' : undefined
    : undefined
  if (encoding !== undefined) {
    const cacheKey = `${file}:${String(stats.mtimeMs)}:${encoding}`
    let body = compressed.get(cacheKey)
    let encodedSize = body === undefined ? -1 : body.length
    let unsafe = false
    if (body === undefined) {
      try {
        const raw = readFileSync(file)
        // Quality 4 is the knee: ~1.8 MB from this build's 11 MB main bundle,
        // where the default (11) takes tens of seconds and blocks the loop.
        body = encoding === 'br'
          ? brotliCompressSync(raw, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
            },
          })
          : gzipSync(raw, { level: 6 })
        compressed.set(cacheKey, body)
      } catch {
        unsafe = true
      }
    }
    if (!unsafe && body !== undefined) {
      encodedSize = body.length
      const compressedEtag = `"${String(encodedSize.toString(16))}-${encoding}"`
      const headers = {
        ...common,
        'content-encoding': encoding,
        'content-length': String(encodedSize),
        vary: 'accept-encoding',
        etag: compressedEtag,
      }
      if ((req.headers['if-none-match'] ?? '') === compressedEtag) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(body)
      return
    }
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range !== null) {
    const start = range[1] === '' ? stats.size - Number(range[2]) : Number(range[1])
    const end = range[2] === '' || range[1] === '' ? stats.size - 1 : Math.min(Number(range[2]), stats.size - 1)
    if (Number.isNaN(start) || start < 0 || start > end || start >= stats.size) {
      res.writeHead(416, { ...common, 'content-range': `bytes */${String(stats.size)}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...common,
      'content-range': `bytes ${String(start)}-${String(end)}/${String(stats.size)}`,
      'content-length': String(end - start + 1),
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { ...common, 'content-length': String(stats.size) })
  createReadStream(file).pipe(res)
}

const tls = certPath !== undefined && keyPath !== undefined
  ? { cert: readFileSync(certPath), key: readFileSync(keyPath) }
  : undefined
const server = tls === undefined ? createHttpServer(handler) : createHttpsServer(tls, handler)
const scheme = tls === undefined ? 'http' : 'https'

server.listen(port, host, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && entry.internal === false)
    .map((entry) => `${scheme}://${entry.address}:${String(port)}/`)
  console.log(`serving dist/ on ${scheme}://127.0.0.1:${String(port)}/ (bind ${host})`)
  for (const address of addresses) console.log(`  LAN: ${address}`)
})
