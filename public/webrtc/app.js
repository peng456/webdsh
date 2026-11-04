/**
 * Page-to-page data channels over the LAN, signaled by the server that served
 * this page.
 *
 * The point of the proof is the shape of the network, not the chat: every page
 * can be reached by the box it was loaded from, so signaling is same-origin and
 * needs no third party; everything after that is a direct DTLS connection
 * between two browsers, and the server sees nothing of it.
 *
 * `iceServers` is empty on purpose. On one LAN both ends have host candidates,
 * and a STUN server would only offer the router's public address back to two
 * machines that can already reach each other.
 */

const ME_KEY = 'webrtc-mesh:id'

/**
 * A stable id, made without `crypto.randomUUID`.
 *
 * This page is served over plain HTTP on a LAN address, which is not a secure
 * context, so `randomUUID` is not defined there — the same reason the harness's
 * own `index.html` carries an equivalent shim. `getRandomValues` is available
 * outside a secure context, so it is the fallback that still gives a random id.
 */
function newId() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const me = localStorage.getItem(ME_KEY) ?? newId()
localStorage.setItem(ME_KEY, me)
document.getElementById('me').textContent = me

const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
const SIGNAL_URL = `${scheme}//${location.host}/__mesh/signal`
document.getElementById('sig-url').textContent = SIGNAL_URL

const $ = (id) => document.getElementById(id)
const log = (line) => {
  const el = $('log')
  el.textContent += `${new Date().toLocaleTimeString()}  ${line}\n`
  el.scrollTop = el.scrollHeight
}
const dot = (on) => { $('ws-state').className = `dot${on ? ' on' : ''}` }

/** One live peer connection, keyed by the peer's signaling id. */
const connections = new Map()
let socket
let reconnectDelay = 500

function connect() {
  socket = new WebSocket(SIGNAL_URL)
  socket.onopen = () => {
    reconnectDelay = 500
    dot(true)
    $('ws-text').textContent = '信令已连接'
    log('signaling connected')
  }
  socket.onclose = () => {
    dot(false)
    $('ws-text').textContent = '信令断开，重连中…'
    setTimeout(connect, (reconnectDelay = Math.min(reconnectDelay * 2, 8000)))
  }
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.type === 'welcome') {
      myId = message.id
      renderPeers(message.peers)
      log(`welcome id=${message.id} peers=${message.peers.length}`)
      return
    }
    if (message.type === 'join') { renderPeers([...currentPeers, message.id]); log(`join ${message.id}`); maybeAuto(message.id); return }
    if (message.type === 'leave') {
      renderPeers(currentPeers.filter((id) => id !== message.id))
      const link = connections.get(message.id)
      if (link !== undefined) { link.pc.close(); connections.delete(message.id); log(`leave ${message.id} (closed)`) }
      return
    }
    if (message.type === 'signal') {
      const link = connection(message.from)
      void handleSignal(link, message.data)
    }
  }
}

let myId = undefined
let currentPeers = []
let autoConnect = false

function renderPeers(ids) {
  currentPeers = [...new Set(ids)].filter((id) => id !== myId)
  const list = $('peers')
  list.innerHTML = ''
  if (currentPeers.length === 0) {
    list.innerHTML = '<li style="opacity:.5">等待其他页面打开这个地址…</li>'
    return
  }
  for (const id of currentPeers) {
    const li = document.createElement('li')
    const marker = document.createElement('span')
    marker.className = `dot${connections.get(id)?.dc?.readyState === 'open' ? ' on' : ''}`
    const label = document.createElement('code')
    label.textContent = id
    const state = document.createElement('span')
    state.id = `state-${id}`
    const link = connections.get(id)
    state.textContent = link === undefined ? '未连接' : link.dc?.readyState === 'open' ? '已直连' : '连接中…'
    state.style.opacity = '.6'
    const button = document.createElement('button')
    button.textContent = '连接'
    button.addEventListener('click', () => void connectTo(id))
    li.append(marker, label, state, button)
    list.append(li)
  }
}

/** One peer connection, created lazily and negotiable in either direction. */
function connection(peerId) {
  const existing = connections.get(peerId)
  if (existing !== undefined) return existing

  // The STUN server this box also serves. Without it, Chrome offers only the
  // candidate its own route table suggests — on a machine with a fake-IP proxy
  // tunnel in front, that is the tunnel's address, which carries nothing. With
  // it, the browser learns its real address on the LAN and ICE has a candidate
  // that both ends can reach.
  const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${location.hostname}:3478` }] })
  /** Signals are per-peer: a page with three links has three conversations. */
  const send = (data) => {
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'signal', to: peerId, data }))
  }
  const link = { pc, peerId, polite: myId !== undefined && myId > peerId, dc: undefined, pending: [], send }
  connections.set(peerId, link)

  pc.onicecandidate = (event) => {
    if (event.candidate === null) return
    const text = event.candidate.candidate
    // The whole point of printing these: `typ host` with a `.local` name means
    // the browser is hiding local addresses behind mDNS; a raw address means it
    // is not; `typ srflx`/`relay` means the traffic is not staying on the LAN.
    const ice = $('ice')
    if (!ice.textContent.includes(text)) ice.textContent += `${text}\n`
    link.send({ candidate: event.candidate })
  }
  pc.onnegotiationneeded = async () => {
    try {
      await pc.setLocalDescription()
      link.send({ description: pc.localDescription })
    } catch (error) { log(`negotiation failed: ${error.message}`) }
  }
  pc.ondatachannel = (event) => { attach(link, event.channel) }
  pc.onconnectionstatechange = () => log(`${peerId} connection=${pc.connectionState}`)
  return link
}

/**
 * The perfect-negotiation pattern: either side may offer, and the polite side
 * yields when both do. It is what keeps a simultaneous "连接" click from
 * wedging the pair.
 */
async function handleSignal(link, data) {
  const { pc } = link
  try {
    if (data.description !== undefined) {
      const collision = data.description.type === 'offer' && pc.signalingState !== 'stable'
      if (collision && !link.polite) { log(`${link.peerId} ignore colliding offer`); return }
      await pc.setRemoteDescription(data.description)
      if (data.description.type === 'offer') {
        await pc.setLocalDescription()
        link.send({ description: pc.localDescription })
      }
      return
    }
    if (data.candidate !== undefined) {
      try { await pc.addIceCandidate(data.candidate) } catch (error) { log(`addIceCandidate: ${error.message}`) }
    }
  } catch (error) { log(`signal error: ${error.message}`) }
}

function attach(link, channel) {
  link.dc = channel
  channel.binaryType = 'arraybuffer'
  channel.onopen = () => {
    log(`${link.peerId} data channel open`)
    $('ping').disabled = false
    $('bw').disabled = false
    renderPeers(currentPeers)
    for (const chunk of link.pending) channel.send(chunk)
    link.pending = []
  }
  channel.onclose = () => { log(`${link.peerId} data channel closed`); renderPeers(currentPeers) }
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      if (event.data.startsWith('ping:')) { channel.send(`pong:${event.data.slice(5)}`); return }
      if (event.data.startsWith('pong:')) {
        const sent = Number(event.data.slice(5))
        log(`${link.peerId} pong ${Math.round(performance.now() - sent)} ms`)
        return
      }
      if (event.data.startsWith('bytes:')) { log(`${link.peerId} 收到 ${event.data.slice(6)} 字节`); return }
      log(`${link.peerId} ← ${event.data}`)
      return
    }
    log(`${link.peerId} ← ${event.data.byteLength} bytes`)
  }
}

async function connectTo(peerId) {
  const link = connection(peerId)
  // The impolite side opens the channel; that is what gives the pair something
  // to negotiate about in the first place.
  if (!link.polite && link.dc === undefined) {
    const channel = link.pc.createDataChannel('mesh')
    attach(link, channel)
  }
  renderPeers(currentPeers)
  log(`→ ${peerId} connecting…`)
}

function maybeAuto(peerId) {
  if (!autoConnect) return
  void connectTo(peerId)
}

$('auto').addEventListener('click', () => {
  autoConnect = !autoConnect
  $('auto').textContent = autoConnect ? '停止自动连接' : '自动连接所有对端'
  if (autoConnect) for (const id of currentPeers) void connectTo(id)
})

$('ping').addEventListener('click', () => {
  for (const link of connections.values()) {
    if (link.dc?.readyState === 'open') link.dc.send(`ping:${performance.now()}`)
  }
})

$('bw').addEventListener('click', () => {
  const link = [...connections.values()].find((candidate) => candidate.dc?.readyState === 'open')
  if (link === undefined) return
  const total = 8 * 1024 * 1024
  const chunk = new Uint8Array(256 * 1024)
  let sent = 0
  const started = performance.now()
  const push = () => {
    while (sent < total) {
      if (link.dc.bufferedAmount > 4 * 1024 * 1024) { setTimeout(push, 8); return }
      link.dc.send(chunk)
      sent += chunk.byteLength
    }
    const seconds = (performance.now() - started) / 1000
    link.dc.send(`bytes:${total}`)
    log(`${link.peerId} 发送 ${(total / 1048576).toFixed(0)} MiB，用时 ${seconds.toFixed(2)}s ≈ ${(total / 1048576 / seconds).toFixed(1)} MiB/s`)
  }
  push()
})

$('clear').addEventListener('click', () => { $('log').textContent = ''; $('ice').textContent = '' })

connect()
window.addEventListener('beforeunload', () => socket?.close())
