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
import { createSocket } from 'node:dgram'
import { WebSocket, WebSocketServer } from 'ws'
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
  // The registry, for peers that have no way to discover a page themselves.
  if (pathname === '/__mesh/api/peers') {
    const now = Date.now()
    const entries = [...registry.values()].filter((entry) => now - entry.at < REGISTRY_TTL_MS)
    const body = JSON.stringify({ ok: true, pages: entries.filter((e) => e.kind === 'page'), desktops: entries.filter((e) => e.kind === 'desktop') })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
    res.end(body)
    return
  }
  let file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''))
  const wantsDocument = (req.headers.accept ?? '').includes('text/html')
  // A directory that has an index is that page: `/webrtc/` is a page, not a
  // missing file, and answering it with the app's index.html would serve the
  // harness where a test page was asked for.
  if (existsSync(file) && statSync(file).isDirectory()) {
    const index = join(file, 'index.html')
    if (existsSync(index)) file = index
  }
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

/**
 * The signaling hub the page-to-page network borrows.
 *
 * WebRTC has no signaling of its own: two browsers cannot find each other, and
 * every exchange of session descriptions has to travel over something that is
 * not WebRTC. This server is already the one thing every page on the LAN can
 * reach — they were loaded from it — so it is the natural place for that
 * exchange, and it costs one upgrade route rather than a second service.
 *
 * It relays and nothing else: it never inspects an SDP, holds no state after a
 * socket closes, and the media/data path afterwards is between the two pages.
 *
 * Protocol (JSON text frames):
 *   server → client  {type:'welcome', id, peers:[id]}
 *                    {type:'join', id} | {type:'leave', id}
 *                    {type:'signal', from, data}
 *   client → server  {type:'signal', to, data}
 */
const SIGNAL_PATH = '/__mesh/signal'
const signalToken = process.env.WEBSH_SIGNAL_TOKEN ?? ''
/**
 * What the hub knows about the pages attached to it.
 *
 * A browser cannot be discovered: no multicast, no listening socket, no address
 * anybody else could dial. So the one thing every page *can* reach — the server
 * it was loaded from — keeps the list instead. Peers ask this on connect, which
 * is why a page appears in a mesh at all.
 *
 * id → { id, machine, capabilities, kind, at }
 */
const registry = new Map()
/** How long a silent registration is still shown; the socket closing removes it. */
const REGISTRY_TTL_MS = 45_000

/** Ports the tunnel may reach; a mesh peer listens on one port and that is all. */
const TUNNEL_PORTS = new Set([Number(process.env.WEBSH_TUNNEL_PORT ?? 45917)])
const TUNNEL_TOKEN = process.env.WEBSH_TUNNEL_TOKEN ?? signalToken

/** Whether an address is on a private IPv4 range (or loopback). */
function isPrivateAddress(address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 127) return true
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}
/** id → socket, for the pages currently attached. */
const peers = new Map()
let peerSeq = 0

const signal = new WebSocketServer({ noServer: true })
signal.on('connection', (socket, request) => {
  const url = new URL(request.url ?? '/', 'http://x')
  if (signalToken !== '' && url.searchParams.get('t') !== signalToken) {
    socket.close(1008, 'bad token')
    return
  }
  peerSeq += 1
  const id = `p${String(peerSeq)}-${Math.random().toString(36).slice(2, 8)}`
  peers.set(id, socket)
  const broadcast = (message) => {
    for (const [other, peer] of peers) {
      if (other === id || peer.readyState !== peer.OPEN) continue
      peer.send(JSON.stringify(message))
    }
  }
  socket.send(JSON.stringify({ type: 'welcome', id, peers: [...peers.keys()].filter((other) => other !== id) }))
  broadcast({ type: 'join', id })

  socket.on('message', (raw) => {
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    // A page announces itself once; that announcement is what `/__mesh/api/peers`
    // answers with. `signal` frames stay a pure relay and are not recorded.
    if (message?.type === 'hello') {
      registry.set(id, {
        id: message.id ?? id,
        machine: String(message.machine ?? ''),
        capabilities: message.capabilities ?? null,
        kind: message.kind === 'desktop' ? 'desktop' : 'page',
        at: Date.now(),
      })
      return
    }
    if (message?.type !== 'signal') return
    const target = peers.get(message.to)
    if (target === undefined || target.readyState !== target.OPEN) return
    target.send(JSON.stringify({ type: 'signal', from: id, data: message.data }))
  })
  socket.on('close', () => {
    peers.delete(id)
    registry.delete(id)
    broadcast({ type: 'leave', id })
  })
  socket.on('error', () => { socket.terminate(); peers.delete(id) })
})

/**
 * A STUN responder, because on this box the browser's own host candidates point
 * at the proxy's TUN interface instead of the LAN.
 *
 * WebRTC needs *some* candidate that both ends can reach. Chrome picks its
 * interfaces itself and, with a fake-IP tunnel in the routing table, the one it
 * offers is the tunnel's address — which does not carry the traffic. A STUN
 * server on the LAN makes the browser learn where it really is, and that
 * candidate crosses the LAN. It answers Binding requests and nothing else
 * (RFC 5389 §7.3), so it holds no state and stores no allocation.
 */
const STUN_PORT = Number(process.env.WEBSH_STUN_PORT ?? 3478)
const MAGIC = 0x2112a442

function startStun() {
  const socket = createSocket('udp4')
  socket.on('message', (message, rinfo) => {
    if (message.length < 20 || message.readUInt16BE(0) !== 0x0001) return
    if (message.readUInt32BE(4) !== MAGIC) return
    const transaction = message.subarray(8, 20)
    const address = rinfo.address.split('.').map(Number)
    if (address.length !== 4) return
    const attribute = Buffer.alloc(12)
    attribute.writeUInt16BE(0x0020, 0) // XOR-MAPPED-ADDRESS
    attribute.writeUInt16BE(8, 2)
    attribute.writeUInt8(0, 4)
    attribute.writeUInt8(0x01, 5) // IPv4
    attribute.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 6)
    for (let i = 0; i < 4; i += 1) attribute.writeUInt8(address[i] ^ ((MAGIC >>> (24 - i * 8)) & 0xff), 8 + i)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(0x0101, 0) // Binding success
    header.writeUInt16BE(12, 2)
    header.writeUInt32BE(MAGIC, 4)
    transaction.copy(header, 8)
    socket.send(Buffer.concat([header, attribute]), rinfo.port, rinfo.address)
  })
  socket.on('error', (error) => console.warn(`[stun] ${error.message}`))
  socket.bind(STUN_PORT, '0.0.0.0', () => console.log(`  stun: stun:${networkInterfaces().en0?.[0]?.address ?? "127.0.0.1"}:${String(STUN_PORT)}`))
}

startStun()

/**
 * The tunnel an https page uses to reach a plain-`ws` peer.
 *
 * A page served over https may only open `wss:` connections, and putting a
 * certificate on every machine on the LAN is not a thing anyone wants to
 * maintain. So the page dials its own origin — a wss the browser already trusts
 * — and this server makes the last hop in plain WebSocket, on the private
 * network, for one allowlisted port. The peer needs no change.
 */
const tunnel = new WebSocketServer({ noServer: true })

tunnel.on('connection', (pageSocket, request) => {
  const url = new URL(request.url ?? '/', 'http://x')
  const target = url.searchParams.get('target') ?? ''
  const [host, rawPort] = target.split(':')
  const port = Number(rawPort ?? TUNNEL_PORTS.values().next().value)
  const token = url.searchParams.get('t') ?? ''
  const refuse = (reason) => {
    try {
      pageSocket.send(JSON.stringify({ type: 'error', error: reason }))
      pageSocket.close(1008, reason)
    } catch { /* 已关 */ }
  }
  if (TUNNEL_TOKEN !== '' && token !== TUNNEL_TOKEN) { refuse('bad token'); return }
  if (!isPrivateAddress(host)) { refuse(`target ${host} is not a private address`); return }
  if (!TUNNEL_PORTS.has(port)) { refuse(`port ${String(port)} is not allowed`); return }

  const peerSocket = new WebSocket(`ws://${host}:${String(port)}/mesh/v1/ws`)
  // A page announces itself immediately, and the first frame can arrive before
  // the peer's TCP connection is up — buffering is the difference between a
  // tunnel that works and one that swallows the handshake.
  const pending = []
  const forward = (from, to) => from.on('message', (data, isBinary) => {
    if (to.readyState === to.OPEN) to.send(data, { binary: isBinary })
    else pending.push([data, isBinary])
  })
  forward(pageSocket, peerSocket)
  peerSocket.on('open', () => {
    for (const [data, isBinary] of pending) peerSocket.send(data, { binary: isBinary })
    pending.length = 0
  })
  forward(peerSocket, pageSocket)
  peerSocket.on('close', () => { try { pageSocket.close() } catch { /* 已关 */ } })
  peerSocket.on('error', (error) => refuse(`peer unreachable: ${error.message}`))
  pageSocket.on('close', () => { try { peerSocket.close() } catch { /* 已关 */ } })
})

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://x')
  if (url.pathname === SIGNAL_PATH) {
    signal.handleUpgrade(request, socket, head, (client) => { signal.emit('connection', client, request) })
    return
  }
  if (url.pathname === '/__mesh/tunnel') {
    tunnel.handleUpgrade(request, socket, head, (client) => { tunnel.emit('connection', client, request) })
    return
  }
  socket.destroy()
})

server.listen(port, host, () => {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && entry.family === 'IPv4' && entry.internal === false)
    .map((entry) => `${scheme}://${entry.address}:${String(port)}/`)
  console.log(`serving dist/ on ${scheme}://127.0.0.1:${String(port)}/ (bind ${host})`)
  for (const address of addresses) console.log(`  LAN: ${address}`)
  console.log(`  signaling: ${scheme}://127.0.0.1:${String(port)}${SIGNAL_PATH}${signalToken === '' ? '' : ' (token required)'}`)
})
