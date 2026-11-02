/**
 * Vendor the default plugin market into this deployment.
 *
 * The page installs plugins itself — a registry name is a plain `fetch`, the
 * tarball unpacks into the virtual filesystem — but "default" means present on
 * the very first boot, before the user has clicked anything, before the
 * service worker controls the page, and even when the registry is unreachable.
 * So the market is vendored instead: its tarball (and the dependencies the
 * page's installer would fetch for it) is unpacked here into `public/`, and
 * `vite` copies `public/` into `dist/` verbatim, giving `/market/` a static,
 * same-origin home.
 *
 * That path keeps us out of the build's source tree: `dist/` is still exactly
 * "the repository's build output, plus static files under `public/`", which is
 * the shape a person can inspect. The seed layer that *installs* it from there
 * lives in `src/plugins/default-market.ts`.
 *
 * Usage:
 *   node scripts/vendor-market.mjs              # unpack public/market/vendor/
 *   node scripts/vendor-market.mjs --fetch      # re-download from the registry first
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = join(root, 'public', 'market', 'vendor')
const REGISTRY = process.env.WEBDHS_REGISTRY ?? 'https://registry.npmjs.org'

/**
 * The market this deployment ships. Change the package here, not the code.
 *
 * `dsh-plugin-shop`: its catalog (dsh-plugin-shop-catalog, on npm) lists
 * `dsh-plugin-mesh` as a real entry at 0.3.33 from peng456/dsh-plugin-mesh,
 * which is the one thing dsh-plugin's own catalog never had.
 *
 * `dshmarket` was tried twice and does not boot here: this build's loader
 * resolves a bare specifier through a package's `exports` map, and undici ships
 * without one (`main: index.js`), so dshmarket's `import ... from 'undici'`
 * fails and the boot disables the row. Everything below is vendored beside it
 * so `import 'zod'` and friends resolve the same way the page's installer
 * would have made them.
 */
const MARKET = { name: 'dsh-plugin-shop', range: '0.8.7' }

/** Packages the market imports that are not `@deepseek-ai/*`, pinned as published. */
const EXTRA = [
  { name: 'zod', version: '4.4.3' },
  { name: 'yaml', version: '2.5.1' },
  { name: 'semver', version: '7.6.3' },
  { name: 'js-yaml', version: '4.3.2' },
]

/**
 * Ask the registry for one version's tarball.
 * @param name - package name.
 * @param range - exact version, or the string `latest`.
 * @returns the version and tarball URL.
 */
async function resolve(name, range) {
  const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`)
  if (!response.ok) throw new Error(`registry: ${name} → ${String(response.status)}`)
  const packument = await response.json()
  // `latest` follows the publisher; an exact pin is honored as written. The
  // tarball URL always comes from that version's manifest.
  const version = range === 'latest' ? packument['dist-tags']?.latest : range
  if (typeof version !== 'string') throw new Error(`registry: ${name} has no version for ${range}`)
  const manifest = packument.versions?.[version]
  const tarball = manifest?.dist?.tarball
  if (typeof tarball !== 'string') throw new Error(`registry: ${name}@${version} has no tarball`)
  return { version, tarball }
}

/** Download one tarball to disk. */
async function download(name, url) {
  const safe = `${name.replace('/', '__')}.tgz`
  const path = join(vendor, safe)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`tarball ${url} → ${String(response.status)}`)
  writeFileSync(path, new Uint8Array(await response.arrayBuffer()))
  return safe
}

/**
 * Unpack a tarball into `node_modules/<name>` the way the page's installer lays
 * it out (the package contents at the root, no `package/` prefix).
 * @param name - package name.
 * @param tarball - file name inside the vendor directory.
 */
function unpack(name, tarball) {
  const target = join(vendor, 'node_modules', ...name.split('/'))
  const staging = `${target}.unpacking`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  // bsdtar ships with macOS and GNU tar with Linux; both accept --strip-components.
  execFileSync('tar', ['-xzf', join(vendor, tarball), '-C', staging, '--strip-components', '1'], { stdio: 'inherit' })
  // The unpacked tree is what gets seeded, so the archive has no further use.
  rmSync(join(vendor, tarball), { force: true })
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  renameSync(staging, target)
}

const fetching = process.argv.includes('--fetch')

if (fetching || !existsSync(join(vendor, 'node_modules', MARKET.name, 'package.json'))) {
  rmSync(vendor, { recursive: true, force: true })
  mkdirSync(vendor, { recursive: true })

  const resolved = []
  for (const job of [{ name: MARKET.name, range: MARKET.range }, ...EXTRA.map(entry => ({ name: entry.name, range: entry.version }))]) {
    const target = await resolve(job.name, job.range === MARKET.range ? MARKET.range : job.range)
    const file = await download(job.name, target.tarball)
    unpack(job.name, file)
    resolved.push({ name: job.name, version: target.version })
    console.log(`[market] ${job.name}@${target.version}`)
  }
  writeFileSync(join(vendor, 'VERSIONS.json'), `${JSON.stringify(Object.fromEntries(resolved.map(entry => [entry.name, entry.version])), null, 2)}\n`)
} else {
  const manifest = JSON.parse(readFileSync(join(vendor, 'node_modules', MARKET.name, 'package.json'), 'utf8'))
  console.log(`[market] vendored ${manifest.name}@${manifest.version} (pass --fetch to refresh)`)
}

// The tree above is reproducible output. Anything the browser host needs on top
// of the published package is described in market-patches/patch.mjs and applied
// here on every run — so `--fetch` cannot quietly drop it, and an upstream
// release that moves a patched line fails the build instead of shipping it.
const { PATCHES } = await import('./market-patches/patch.mjs')
for (const patch of PATCHES) {
  // A patch whose replacement is a whole file names it; `replaceFile` is read
  // from the patches directory so the source stays a real file with its own
  // syntax highlighting, quotes and backticks included.
  if (patch.replaceFile !== undefined) {
    const source = join(dirname(fileURLToPath(import.meta.url)), 'market-patches', patch.replaceFile)
    patch.replace = readFileSync(source, 'utf8')
  }
  // A patch belongs to the package it names. When this build ships a different
  // market, its patches simply have no package to apply to — that is not an
  // error, it is the other market being vendored.
  if (!existsSync(join(vendor, 'node_modules', patch.package, 'package.json'))) continue
  const path = join(vendor, 'node_modules', patch.package, patch.file)
  if (!existsSync(path)) throw new Error(`[market] patch target is missing: ${patch.package}/${patch.file}`)
  const text = readFileSync(path, 'utf8')
  // An insertion patch carries its anchor inside its replacement, so the anchor
  // keeps matching after it lands. Its `marker` is what says "already there".
  if (patch.marker !== undefined && text.includes(patch.marker)) continue
  const occurrences = text.split(patch.find).length - 1
  if (occurrences === 1) {
    writeFileSync(path, text.replace(patch.find, patch.replace))
    console.log(`[market] patched ${patch.package}/${patch.file}`)
    continue
  }
  if (occurrences === 0 && text.includes(patch.replace)) {
    // Already applied by an earlier run of this same version.
    continue
  }
  throw new Error(`[market] patch for ${patch.package}/${patch.file} matched ${String(occurrences)} times; the package changed upstream. Update scripts/market-patches/patch.mjs. Because: ${patch.why}`)
}
