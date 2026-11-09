/**
 * Make the built app work at a project path, not just at an origin root.
 *
 * Two things in the runtime are addressed from the origin root and are therefore
 * wrong on `https://<user>.github.io/<repo>/`:
 *
 *   1. The kernel worker URL is the absolute string `/assets/kernel-worker-*.js`.
 *      The workers are copied next to the app's own chunks, so a path relative to
 *      the bundle is both correct and deployment-agnostic.
 *   2. The kernel resolves `vendor/npm-pack.bin` against `location.origin`. A
 *      worker knows its own URL; resolving against that puts the asset under
 *      `assets/vendor/`, which is where this script also copies it.
 *
 * Rewriting the emitted bundle (rather than the SDK source) keeps the vendored
 * package unmodified and works for whatever hashed chunk Vite produced.
 *
 * Usage: `node scripts/fix-subpath.mjs` (after `vite build`)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = process.env.WEBSH_DIST ?? join(root, 'dist')
const assets = join(dist, 'assets')

if (!existsSync(assets)) throw new Error(`[subpath] ${assets} is missing; run vite build first`)

let rewritten = 0
for (const name of readdirSync(assets)) {
  if (!name.endsWith('.js')) continue
  const path = join(assets, name)
  const before = readFileSync(path, 'utf8')
  // `/assets/kernel-worker-x.js` → `./kernel-worker-x.js`, resolved against the
  // bundle's own URL, which is where the file actually sits.
  let after = before.replace(/"\/assets\/(kernel-worker-[A-Za-z0-9_-]+\.js)"/g, '"./$1"')
  // The kernel's vendor asset lookup: origin-absolute → worker-relative.
  after = after.replace(
    /return \(self\.location && self\.location\.origin \|\| ""\) \+ \(typeof import\.meta !== "undefined" && "\/" \|\| "\/"\) \+ name;/g,
    'return new URL(name, self.location.href).href;',
  )
  if (after !== before) {
    writeFileSync(path, after)
    rewritten += 1
  }
}

// `vendor/npm-pack.bin` is fetched relative to the kernel worker, which lives in
// `assets/`.
const pack = join(dist, 'vendor', 'npm-pack.bin')
if (existsSync(pack)) {
  const target = join(assets, 'vendor')
  mkdirSync(target, { recursive: true })
  copyFileSync(pack, join(target, 'npm-pack.bin'))
}

console.log(`[subpath] rewrote ${String(rewritten)} chunk(s); vendored npm pack under assets/vendor/`)
