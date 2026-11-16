/**
 * The smallest possible peer network: one WebSocket to an always-on machine.
 *
 * The server keeps `id → socket` and does two things — tells everyone who
 * arrived, and hands a message to the id it names. Nothing here discovers
 * anything, because there is nothing to discover: the page connects out, says
 * who it is, and the hub knows.
 *
 * It is deliberately not the mesh plugin: that one needs a runtime, a pairing
 * model and a task model. This is the substrate those ride on, and the thing to
 * reach for when the question is only "can two browsers talk".
 */

const KEY = 'lan-ws-hub:id'
const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
const url = `${scheme}//${location.host}/__mesh/signal`
const me = localStorage.getItem(KEY) ?? randomId()
localStorage.setItem(KEY, me)

const $ = (id) => document.getElementById(id)
const log = (line) => {
  const at = new Date().toLocaleTimeString()
  $('log').textContent += `${at}  ${line}\n`
  $('log').scrollTop = $('log').scrollHeight
}

/** An id that survives reloads without needing a secure context. */
function randomId() {
  const bytes = new Uint8Array(8)
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

let socket
let retry = 600
let peers = []
let target

function connect() {
  socket = new WebSocket(url)
  socket.onopen = () => {
    retry = 600
    $('dot').className = 'dot on'
    $('state').textContent = '已连接'
    socket.send(JSON.stringify({ type: 'hello', id: me, machine: navigator.platform || 'page', kind: 'page' }))
    log(`connected ${url}`)
  }
  socket.onclose = (event) => {
    $('dot').className = 'dot'
    $('state').textContent = `断开（${event.code}），重连中…`
    setTimeout(connect, (retry = Math.min(retry * 2, 10000)))
  }
  socket.onmessage = (event) => {
    let message
    try { message = JSON.parse(String(event.data)) } catch { return }
    if (message.type === 'welcome') {
      $('me').textContent = message.id
      peers = message.peers.filter((id) => id !== message.id)
      renderPeers()
      log(`welcome: ${message.id}，在线 ${peers.length} 个对端`)
      return
    }
    if (message.type === 'join') {
      if (!peers.includes(message.id)) peers.push(message.id)
      renderPeers()
      log(`join: ${message.id}`)
      return
    }
    if (message.type === 'leave') {
      peers = peers.filter((id) => id !== message.id)
      if (target === message.id) target = undefined
      renderPeers()
      log(`leave: ${message.id}`)
      return
    }
    if (message.type === 'signal' && message.from !== me) {
      const data = message.data ?? {}
      if (typeof data.sentAt === 'number') {
        // Answer a ping with a pong so the sender can measure a round trip.
        socket.send(JSON.stringify({ type: 'signal', to: message.from, data: { pong: data.sentAt } }))
      }
      if (typeof data.pong === 'number') {
        $('rtt').textContent = `往返 ${Math.round(performance.now() - data.pong)} ms`
        log(`← ${message.from}: pong`)
        return
      }
      log(`← ${message.from}: ${data.text ?? JSON.stringify(data).slice(0, 120)}`)
    }
  }
}

function renderPeers() {
  const list = $('peers')
  list.innerHTML = ''
  if (peers.length === 0) {
    list.innerHTML = '<li style="opacity:.5">等待其他页面连上来…</li>'
    return
  }
  for (const id of peers) {
    const li = document.createElement('li')
    const label = document.createElement('label')
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'peer'
    radio.checked = id === target
    radio.addEventListener('change', () => { target = id; $('target').textContent = id })
    const code = document.createElement('code')
    code.textContent = id
    label.append(radio, code)
    li.append(label)
    list.append(li)
  }
}

function send(payload) {
  if (target === undefined) { log('先在上面选一个目标'); return }
  socket?.send(JSON.stringify({ type: 'signal', to: target, data: payload }))
  log(`→ ${target}: ${payload.text ?? 'ping'}`)
}

$('send').addEventListener('click', () => {
  const text = $('text').value.trim()
  if (text === '') return
  send({ text, sentAt: performance.now() })
  $('text').value = ''
})
$('text').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('send').click() }
})
$('echo').addEventListener('click', () => {
  // A one-click ping: the peer answers and the round trip is measured, which is
  // the whole claim of this page in one number.
  send({ text: `ping from ${me}`, sentAt: performance.now() })
})

connect()
