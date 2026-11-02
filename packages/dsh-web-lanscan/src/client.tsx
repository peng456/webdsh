/**
 * The LAN scanner's browser half.
 *
 * What a page may know about its own network is narrow, and this file is
 * written against that boundary rather than around it:
 *
 * - A page cannot read an ARP table, send ICMP, ask the router, or multicast.
 *   None of those are permissions to request; the APIs do not exist.
 * - A page *can* open a TCP connection — `fetch` is one. So the only discovery
 *   available here is unicast probing: try an address, keep what answers.
 *
 * An answer is also not a fact about the network. Measured on one LAN: a live
 * host with the port closed refuses in 15–80 ms, an open port whose response
 * carries no CORS header may take 1.2–1.3 s, and an address with no host
 * usually refuses in 20–70 ms but sometimes hangs past 2.5 s. So a probe has
 * three outcomes, not two — answered, refused, timed out — and only the first
 * is evidence of anything. This file reports them as three buckets and never
 * invents a verdict from a timeout.
 *
 * Because that timing is noisy, the scan runs in two passes: a fast sweep that
 * finds everything willing to answer quickly, then a slow re-probe of the
 * addresses that only timed out. The slow pass is cheap because it is small.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/** What one probe learned. Only `open` is evidence that something is there. */
type Outcome = 'open' | 'refused' | 'timeout'

/** One address's result. */
interface Hit {
  host: string
  outcome: Outcome
  ms: number
  /** HTTP status, when the response was readable (the target allowed CORS). */
  status?: number
  /** JSON identity, when the target answered a readable request. */
  identity?: Record<string, unknown>
}

/** Persisted results, so a reload does not start from nothing. */
const CACHE_KEY = 'dsh-web-lanscan:last'
const CACHE_TTL = 10 * 60 * 1000

/**
 * The /24 this page appears to be on.
 *
 * A page cannot read its own address, but it does know the URL it was served
 * from. When that is a literal address the subnet is right there; otherwise
 * there is nothing to infer from, so loopback is the honest default.
 * @returns three octets, e.g. `192.168.1`.
 */
function defaultSubnet(): string {
  const host = location.hostname
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').slice(0, 3).join('.')
  return '127.0.0'
}

/**
 * Probe one address.
 *
 * `cors` is deliberate, and it is the lesson of the measurements this file was
 * built against: `no-cors` cannot be used to detect anything. A cross-origin
 * JSON body is blocked by Opaque Response Blocking even when the target *does*
 * send `Access-Control-Allow-Origin`, so a `no-cors` probe fails against a
 * service that is plainly reachable. Measured on this LAN: the same open port
 * answered a `cors` request in 20 ms and rejected every `no-cors` one.
 *
 * The cost of that choice is stated in the panel: only a target that allows
 * cross-origin reads can be discovered at all. Everything else — a closed port,
 * an address with no host, and an open port with no CORS header — reports the
 * same way, and this file never pretends to tell them apart.
 * @param host - the address.
 * @param port - the port.
 * @param path - the path to request.
 * @param timeoutMs - how long to wait before calling it a timeout.
 * @returns what happened, how long it took, and what the target said about itself.
 */
async function probe(host: string, port: number, path: string, timeoutMs: number): Promise<Hit> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(`http://${host}:${port}${path}`, {
      mode: 'cors',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    })
    const hit: Hit = { host, outcome: 'open', ms: Math.round(performance.now() - started), status: response.status }
    try {
      hit.identity = await response.json() as Record<string, unknown>
    } catch {
      // Readable but not JSON: still a discovery, just an anonymous one.
    }
    return hit
  } catch (error) {
    const ms = Math.round(performance.now() - started)
    return { host, outcome: (error as Error)?.name === 'AbortError' ? 'timeout' : 'refused', ms }
  } finally {
    clearTimeout(timer)
  }
}

/** Run probes with a fixed number in flight, preserving input order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await work(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Sweep a /24 in two passes.
 * @param subnet - three octets.
 * @param port - the port to probe.
 * @param path - the path to request.
 * @param fastMs - first-pass timeout; the knob that decides how long the sweep takes.
 * @param onProgress - called with the number of addresses finished.
 * @returns every address that answered, plus the counts behind the sweep.
 */
async function sweep(
  subnet: string,
  port: number,
  path: string,
  fastMs: number,
  onProgress: (done: number, total: number) => void,
): Promise<{ hits: Hit[], refused: number, timedOut: number }> {
  const hosts = Array.from({ length: 254 }, (_, index) => `${subnet}.${String(index + 1)}`)
  let done = 0
  const first = await pool(hosts, 128, async host => {
    const hit = await probe(host, port, path, fastMs)
    onProgress(++done, hosts.length)
    return hit
  })

  // Second pass: only the ones that told us nothing. A slow answer is still an
  // answer, and dropping these would report a quiet host as absent.
  const quiet = first.filter(hit => hit.outcome === 'timeout')
  const second = await pool(quiet, 32, async hit => {
    const retried = await probe(hit.host, port, path, Math.max(1500, fastMs * 4))
    onProgress(++done, hosts.length + quiet.length)
    return retried
  })

  const merged = [...first.filter(hit => hit.outcome !== 'timeout'), ...second]
  const hits = merged.filter(hit => hit.outcome === 'open')
  return {
    hits,
    refused: merged.filter(hit => hit.outcome === 'refused').length,
    timedOut: merged.filter(hit => hit.outcome === 'timeout').length,
  }
}

/** A radar, at 16px like the icons beside it. */
function ScanIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 8l4.4-4.4" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The panel.
 * @param props - `onClose` dismisses it.
 * @returns the scanner.
 */
function ScanPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const [subnet, setSubnet] = useState(defaultSubnet)
  const [port, setPort] = useState('45917')
  const [path, setPath] = useState('/mesh/v1/health')
  const [fastMs, setFastMs] = useState('250')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number, total: number } | undefined>(undefined)
  const [hits, setHits] = useState<Hit[]>([])
  const [counts, setCounts] = useState<{ refused: number, timedOut: number } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const insecure = location.protocol === 'https:'
  const cancelled = useRef(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (raw === null) return
      const entry = JSON.parse(raw) as { at?: number, hits?: Hit[], subnet?: string, port?: string }
      if (typeof entry.at !== 'number' || Date.now() - entry.at > CACHE_TTL) return
      if (Array.isArray(entry.hits)) setHits(entry.hits)
      if (typeof entry.subnet === 'string') setSubnet(entry.subnet)
      if (typeof entry.port === 'string') setPort(entry.port)
    } catch { /* a blocked store just means an empty panel */ }
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    setHits([])
    setCounts(undefined)
    cancelled.current = false
    setProgress({ done: 0, total: 254 })
    try {
      const result = await sweep(subnet, Number(port), path, Math.max(50, Number(fastMs)), (done, total) => {
        if (!cancelled.current) setProgress({ done, total })
      })
      setHits(result.hits)
      setCounts({ refused: result.refused, timedOut: result.timedOut })
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), subnet, port, hits: result.hits }))
      } catch { /* best effort */ }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRunning(false)
      setProgress(undefined)
    }
  }, [subnet, port, path, fastMs])

  return (
    <div className="dsh-lanscan-panel" role="dialog" aria-label="局域网扫描">
      <header className="dsh-lanscan-head">
        <strong>局域网扫描</strong>
        <button type="button" className="dsh-lanscan-close" onClick={onClose} aria-label="关闭">×</button>
      </header>

      <p className="dsh-lanscan-note">
        页面没有 UDP、ARP、ICMP，也没有任何“列出局域网 IP”的接口。唯一可行的事是逐个发起
        TCP 探测。实测结论：<strong>只有允许跨源读取（发 <code>Access-Control-Allow-Origin</code>）的服务能被发现</strong>；
        端口关闭、主机不存在、开着但没发 CORS 头，三者返回的结果完全一样。
      </p>

      <div className="dsh-lanscan-row">
        <label>网段<input value={subnet} onChange={event => setSubnet(event.target.value.trim())} spellCheck={false} /></label>
        <label>端口<input value={port} onChange={event => setPort(event.target.value.trim())} inputMode="numeric" /></label>
      </div>
      <div className="dsh-lanscan-row">
        <label>路径<input value={path} onChange={event => setPath(event.target.value)} spellCheck={false} /></label>
        <label>首轮超时<input value={fastMs} onChange={event => setFastMs(event.target.value.trim())} inputMode="numeric" /> ms</label>
      </div>

      <div className="dsh-lanscan-actions">
        <button type="button" className="dsh-lanscan-run" disabled={running} onClick={() => { void run() }}>
          {running ? '扫描中…' : '开始扫描'}
        </button>
        {running && <button type="button" className="dsh-lanscan-stop" onClick={() => { cancelled.current = true }}>停止</button>}
        {progress !== undefined && <span className="dsh-lanscan-progress">{progress.done}/{progress.total}</span>}
      </div>

      {insecure && <p className="dsh-lanscan-warn">当前页面是 HTTPS，浏览器会以混合内容为由拦掉所有 http:// 探测。请用 http 源打开。</p>}
      {error !== undefined && <p className="dsh-lanscan-warn">{error}</p>}

      {hits.length > 0 && (
        <ul className="dsh-lanscan-hits">
          {hits.map(hit => (
            <li key={hit.host}>
              <a href={`http://${hit.host}:${port}${path}`} target="_blank" rel="noreferrer noopener">{hit.host}:{port}</a>
              <span className="dsh-lanscan-badge">{hit.ms} ms</span>
              {hit.identity !== undefined
                ? <span className="dsh-lanscan-id">{String(hit.identity.machine ?? hit.identity.app ?? hit.identity.ok ?? '已识别')}</span>
                : <span className="dsh-lanscan-id dsh-lanscan-dim">可跨源读取，但响应不是 JSON</span>}
            </li>
          ))}
        </ul>
      )}

      {!running && hits.length === 0 && counts !== undefined && (
        <p className="dsh-lanscan-note">
          没有可发现的服务。{counts.refused} 个无应答，{counts.timedOut} 个超时。
          这两类都无法区分“端口关闭 / 主机不存在 / 服务没发 CORS 头”，所以不能据此判断网段里有没有设备。
        </p>
      )}
    </div>
  )
}

/** The foot action, wearing the row shape of the Settings entry above it. */
function ScanAction({ wide }: { wide: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="dsh-lanscan-trigger"
        {...(wide ? {} : { 'data-rail': '' })}
        onClick={() => setOpen(value => !value)}
        title="扫描本网段的 HTTP 服务"
        aria-label="局域网扫描"
      >
        <ScanIcon />
        {wide && <span className="dsh-lanscan-label">局域网扫描</span>}
      </button>
      {open && <ScanPanel onClose={() => setOpen(false)} />}
    </>
  )
}

const STYLE = `
.dsh-lanscan-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex:0 0 calc(100% + 8px);
 width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;
 background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;
 line-height:22px;text-align:left;cursor:pointer;overflow:hidden}
.dsh-lanscan-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsh-lanscan-trigger[data-rail]{flex:0 0 36px;justify-content:center;gap:0;width:36px;height:36px;
 margin:4px 0;padding:0;border-radius:50%}
.dsh-lanscan-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-lanscan-panel{position:fixed;left:96px;bottom:72px;z-index:60;width:min(520px,calc(100vw - 120px));
 max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:14px;
 border:1px solid var(--dsw-alias-border-l2,#d0d0d0);border-radius:12px;
 background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 28px rgba(0,0,0,.18);
 color:var(--dsw-alias-label-primary,#111);font-size:13px;line-height:1.6}
.dsh-lanscan-head{display:flex;align-items:center;justify-content:space-between}
.dsh-lanscan-close{border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}
.dsh-lanscan-note{margin:0;color:var(--dsw-alias-label-secondary,#666)}
.dsh-lanscan-warn{margin:0;color:#b45309}
.dsh-lanscan-row{display:flex;gap:8px;flex-wrap:wrap}
.dsh-lanscan-row label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dsh-lanscan-row input{width:120px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);
 border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fafafa);color:inherit;font-size:12px;font-family:inherit}
.dsh-lanscan-actions{display:flex;align-items:center;gap:10px}
.dsh-lanscan-run{padding:5px 14px;border:1px solid var(--dsw-alias-brand-primary,#3b6cf6);border-radius:6px;
 background:var(--dsw-alias-brand-primary,#3b6cf6);color:var(--dsw-alias-bg-base,#fff);font-size:13px;cursor:pointer}
.dsh-lanscan-run:disabled{opacity:.6;cursor:wait}
.dsh-lanscan-stop{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,#d0d0d0);border-radius:6px;
 background:transparent;color:inherit;font-size:13px;cursor:pointer}
.dsh-lanscan-progress{font-size:12px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsh-lanscan-hits{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dsh-lanscan-hits li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 8px;border-radius:8px;
 background:var(--dsw-alias-bg-layer-2,#f6f6f6)}
.dsh-lanscan-hits a{color:var(--dsw-alias-brand-primary,#3b6cf6);text-decoration:none;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.dsh-lanscan-badge{font-size:11px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsh-lanscan-id{font-size:12px}
.dsh-lanscan-dim{color:var(--dsw-alias-label-tertiary,#888)}
`

/** Services this half waits for. */
export const inject = ['slots']

/**
 * Mount the browser half.
 * @param ctx - the client plugin's context.
 */
export function apply(ctx: Context): void {
  if (document.getElementById('dsh-lanscan-chrome') === null) {
    const style = document.createElement('style')
    style.id = 'dsh-lanscan-chrome'
    style.textContent = STYLE
    document.head.append(style)
  }

  const slots = ctx.get('slots') as {
    inject(name: string, factory: () => unknown): void
    register(options: { name: string, id: string, order?: number, label?: string }, component: unknown): unknown
  } | undefined
  if (slots === undefined) return

  slots.inject('sidebar.footer.action', () => slots.register(
    { name: 'sidebar.footer.action', id: 'web-lanscan', order: 90, label: '局域网扫描' },
    ScanAction,
  ))
}

export default { apply, inject }
