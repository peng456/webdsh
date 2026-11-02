/**
 * Put the runtime's assets where the page fetches them.
 *
 * `@vivari/core` reaches its kernel, process and filesystem workers through
 * root-absolute URLs (`/assets/kernel-worker-*.js`), which a bundler cannot
 * rewrite and a dependency install cannot place. So they are copied verbatim,
 * the same way `scripts/build-v86.mjs` copies the emulator's Wasm, and for the
 * same reason: the page is cross-origin isolated, and every subresource it loads
 * has to come from this origin.
 *
 * `vendor/npm-pack.bin` beside them is npm itself — the kernel unpacks it on the
 * first `npm`/`npx`. It is a build artifact of the upstream repository
 * (`scripts/vendor-npm.mjs` there) and is committed here rather than rebuilt,
 * because rebuilding it needs a registry round trip and an arborist patch that
 * belong to that project, not to this one. If it is missing, this script says so
 * and the build still succeeds; npm then reports its own 404 at first use.
 *
 * Usage: `node scripts/vendor-vivari.mjs`
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules', '@vivari', 'core', 'dist', 'assets')
const target = join(root, 'public', 'assets')

if (!existsSync(source)) throw new Error(`[vivari] ${source} is missing; run npm install`)

mkdirSync(target, { recursive: true })
let copied = 0
let bytes = 0
for (const name of readdirSync(source)) {
  const from = join(source, name)
  if (!statSync(from).isFile()) continue
  copyFileSync(from, join(target, name))
  copied += 1
  bytes += statSync(from).size
}
console.log(`[vivari] copied ${String(copied)} runtime assets into public/assets (${(bytes / 1e6).toFixed(1)} MB)`)

const pack = join(root, 'public', 'vendor', 'npm-pack.bin')
if (existsSync(pack)) {
  console.log(`[vivari] npm pack present (${(statSync(pack).size / 1e6).toFixed(1)} MB)`)
} else {
  console.warn('[vivari] public/vendor/npm-pack.bin is missing; `npm`/`npx` inside the runtime will 404 until it is restored')
}
