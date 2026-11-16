/**
 * The hub every page joins, and the small panel that shows it.
 *
 * A browser page cannot be found: no multicast, no listening socket, no address
 * anyone could dial. A page *can* open one outbound WebSocket, so the network is
 * a star — one always-on machine keeps `id → socket`, broadcasts who arrived,
 * and forwards a message to the id it names. This module is the page half of
 * that, loaded with the app so every tab joins without being told to.
 *
 * The hub is the origin that served the page unless told otherwise, because the
 * usual deployment has the app and the hub on the same machine. `__DSH_HUB__`
 * overrides it, and `__DSH_HUB_FALLBACKS__` lists alternatives to try when the
 * origin does not answer (a static host, for instance, which serves the app but
 * has no relay).
 */

/** Which hub to talk to, once one has answered. */
let hub = ''
/** This page's stable identity in the network. */
const ID_KEY = 'dsh-hub:id'

/** `wss` for an https hub, `ws` otherwise — the colon belongs to the URL. */
const schemeFor = (base: string): string => (base.startsWith('https:') ? 'wss' : 'ws')

/** An id that survives reloads; `randomUUID` needs a secure context. */
function newId(): string {
  const bytes = new Uint8Array(8)
  if (typeof crypto?.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

const me = (() => {
  try {
    const stored = localStorage.getItem(ID_KEY)
    if (stored !== null && stored !== '') return stored
    const created = newId()
    localStorage.setItem(ID_KEY, created)
    return created
  } catch {
    return newId()
  }
})()

/**
 * Find a hub that answers.
 *
 * The probe is a plain GET on the registry route: a static host answers 404, a
 * relay answers JSON. Cheap, same-origin, and it settles before a socket is
 * opened.
 * @returns the hub origin, or '' when there is none.
 */
async function resolveHub(): Promise<string> {
  const configured = (globalThis as { __DSH_HUB__?: string }).__DSH_HUB__
  // Where the hub lives, in order: an explicit override, this page's own origin
  // (the usual case — the app and the relay are the same machine), then the
  // addresses this deployment is known to run on. The last group is what lets a
  // copy served from somewhere else — a static host, a file — still find the LAN
  // hub when the browser can reach it.
  const known = (globalThis as { __DSH_HUB_FALLBACKS__?: string[] }).__DSH_HUB_FALLBACKS__ ?? [
    'http://127.0.0.1:4173',
    'http://192.168.1.5:4173',
  ]
  const candidates = [
    ...(configured === undefined ? [] : [configured]),
    location.origin,
    ...known,
  ]
  for (const base of candidates) {
    try {
      const url = new URL('/__mesh/api/peers', base)
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(2500) })
      if (response.ok) return url.origin
    } catch {
      // Next candidate: this one is unreachable, or not a hub at all.
    }
  }
  return ''
}

/** Peers currently attached, as the hub reports them. */
let peers: string[] = []
let target = ''
let socket: WebSocket | undefined
let retry = 700
let panel: HTMLElement | undefined
let logLines: string[] = []
let lastRtt: number | undefined

/** A tiny always-there widget: present, but not in the way. */
function mount(): HTMLElement {
  if (panel !== undefined) return panel
  const root = document.createElement('div')
  root.id = 'dsh-hub-panel'
  root.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483000',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:inherit', 'background:color-mix(in srgb, Canvas 92%, transparent)',
    'border:1px solid color-mix(in srgb, currentColor 22%, transparent)',
    'border-radius:9px', 'box-shadow:0 6px 22px rgba(0,0,0,.16)', 'overflow:hidden',
    'backdrop-filter:blur(6px)', 'max-width:min(360px, 88vw)',
  ].join(';')
  root.innerHTML = `
    <button id="dsh-hub-toggle" style="all:unset;cursor:pointer;display:flex;gap:7px;align-items:center;padding:6px 10px;width:100%;box-sizing:border-box">
      <span id="dsh-hub-dot" style="width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.25"></span>
      <span id="dsh-hub-title">互联</span>
    </button>
    <div id="dsh-hub-body" style="display:none;padding:0 10px 10px">
      <div style="opacity:.7;margin-bottom:6px" id="dsh-hub-me"></div>
      <ul id="dsh-hub-peers" style="list-style:none;margin:0 0 8px;padding:0"></ul>
      <div style="display:flex;gap:6px">
        <input id="dsh-hub-text" placeholder="发给选中对端" style="flex:1;min-width:0;background:transparent;color:inherit;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:6px;padding:3px 7px;font:inherit" />
        <button id="dsh-hub-send" style="font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:6px;padding:3px 9px;cursor:pointer">发送</button>
      </div>
      <pre id="dsh-hub-log" style="margin:8px 0 0;max-height:120px;overflow:auto;white-space:pre-wrap;opacity:.78"></pre>
    </div>`
  document.body.append(root)
  panel = root
  root.querySelector('#dsh-hub-toggle')?.addEventListener('click', () => {
    const body = root.querySelector<HTMLElement>('#dsh-hub-body')
    if (body !== null) body.style.display = body.style.display === 'none' ? 'block' : 'none'
  })
  root.querySelector('#dsh-hub-send')?.addEventListener('click', () => publish())
  root.querySelector<HTMLInputElement>('#dsh-hub-text')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') publish()
  })
  render()
  return root
}

const log = (line: string): void => {
  logLines = [...logLines.slice(-40), `${new Date().toLocaleTimeString()}  ${line}`]
  const el = panel?.querySelector<HTMLElement>('#dsh-hub-log')
  if (el != null) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight }
}

/** Redraw the peer list and the status line. */
function render(): void {
  if (panel === undefined) return
  const dot = panel.querySelector<HTMLElement>('#dsh-hub-dot')
  if (dot !== null) dot.style.opacity = socket?.readyState === WebSocket.OPEN ? '1' : '.25'
  const title = panel.querySelector<HTMLElement>('#dsh-hub-title')
  if (title !== null) title.textContent = `互联 ${String(peers.length)}`
  const meEl = panel.querySelector<HTMLElement>('#dsh-hub-me')
  if (meEl !== null) meEl.textContent = `${me}${lastRtt === undefined ? '' : ` ・ 往返 ${String(lastRtt)}ms`}`
  const list = panel.querySelector<HTMLElement>('#dsh-hub-peers')
  if (list === null) return
  list.textContent = ''
  if (peers.length === 0) {
    const item = document.createElement('li')
    item.style.opacity = '.55'
    item.textContent = '还没有其他页面'
    list.append(item)
    return
  }
  for (const id of peers) {
    const item = document.createElement('li')
    item.style.cssText = 'cursor:pointer;padding:1px 0;display:flex;gap:6px;align-items:center'
    const mark = document.createElement('span')
    mark.textContent = id === target ? '●' : '○'
    mark.style.opacity = id === target ? '1' : '.5'
    const label = document.createElement('code')
    label.textContent = id
    item.append(mark, label)
    item.addEventListener('click', () => { target = id; render() })
    list.append(item)
  }
}

/** Send the box's text to the selected peer. */
function publish(): void {
  const input = panel?.querySelector<HTMLInputElement>('#dsh-hub-text')
  const text = input?.value.trim() ?? ''
  if (text === '' || target === '' || socket?.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'signal', to: target, data: { text, sentAt: performance.now() } }))
  log(`→ ${target}: ${text}`)
  if (input !== null) input.value = ''
}

/** Open the socket, announce, and answer whatever arrives. */
function connect(): void {
  if (hub === '') return
  const url = `${schemeFor(hub)}://${new URL(hub).host}/__mesh/signal`
  socket = new WebSocket(url)
  socket.onopen = () => {
    retry = 700
    socket?.send(JSON.stringify({ type: 'hello', id: me, machine: navigator.platform || 'page', kind: 'page' }))
    log(`已连上汇聚点 ${new URL(hub).host}`)
    render()
  }
  socket.onclose = (event) => {
    render()
    log(`断开（${String(event.code)}），${String(Math.round(retry / 100) / 10)}s 后重连`)
    setTimeout(connect, (retry = Math.min(retry * 2, 10000)))
  }
  socket.onmessage = (event: MessageEvent) => {
    let message: { type?: string, id?: string, peers?: string[], from?: string, data?: { text?: string, sentAt?: number, pong?: number } }
    try { message = JSON.parse(String(event.data)) as typeof message } catch { return }
    if (message.type === 'welcome') {
      peers = (message.peers ?? []).filter((id) => id !== me)
      render()
      return
    }
    if (message.type === 'join' && message.id !== undefined && !peers.includes(message.id)) {
      peers = [...peers, message.id]
      render()
      return
    }
    if (message.type === 'leave' && message.id !== undefined) {
      peers = peers.filter((id) => id !== message.id)
      if (target === message.id) target = ''
      render()
      return
    }
    if (message.type !== 'signal' || message.from === undefined) return
    const data = message.data ?? {}
    if (typeof data.sentAt === 'number') {
      socket?.send(JSON.stringify({ type: 'signal', to: message.from, data: { pong: data.sentAt } }))
    }
    if (typeof data.pong === 'number' && typeof data.sentAt !== 'number') {
      lastRtt = Math.round(performance.now() - data.pong)
      render()
      return
    }
    log(`← ${message.from}: ${data.text ?? ''}`)
  }
}

/** Boot: find a hub, show the panel, connect. */
async function start(): Promise<void> {
  hub = await resolveHub()
  mount()
  if (hub === '') {
    log('这个地址上没有汇聚点；页面之间的互联不可用')
    const title = panel?.querySelector<HTMLElement>('#dsh-hub-title')
    if (title !== null) title.textContent = '互联（无汇聚点）'
    return
  }
  log(`汇聚点 ${hub}`)
  connect()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void start() })
else void start()
