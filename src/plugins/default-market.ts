/**
 * The plugin market this deployment ships as a default.
 *
 * A default is not the same thing as an installed plugin. On a real machine a
 * default is npm and pnpm: a way to add things, present before the user has
 * asked for anything. This page has an installer (`src/plugins/manager.ts`) but
 * no storefront, so the storefront is the default — `dshmarket`, vendored into
 * the build at assemble time so it works on the first boot, offline, and
 * before any registry round-trip.
 *
 * Three things have to be true at once for it to appear:
 *
 * 1. the package files sit under the plugin module root the loader reads;
 * 2. its dependencies sit there too, since the loader resolves the market's own
 *    `import` specifiers from that root;
 * 3. the roster (`/opt/dsh/plugins/installed.json`) names it, because that file
 *    is what the boot turns into composition layers.
 *
 * The files are a build artifact (see `scripts/vendor-market.mjs`) and ship in
 * the VFS seed table like every other deployment file. The roster is the one
 * exception, because it is *user* state: it is written on first boot, and only
 * when it does not mention the market at all. Once the user has met it —
 * enabled, disabled, or removed on purpose — the roster is the record and the
 * boot leaves that decision alone.
 */

import { volume } from '../vfs/volume.ts'
import { toBytes, toText } from '../node/binary.ts'
import { dirname } from '../vfs/path.ts'

/** The market's package name, as the roster and the installer know it. */
export const DEFAULT_MARKET = 'dsh-plugin-shop'

/** Where the roster lives. Kept in step with `src/plugins/manager.ts`. */
const ROSTER_PATH = '/opt/dsh/plugins/installed.json'

/** The packages `scripts/vendor-market.mjs` unpacks. */
const VENDORED = ['dsh-plugin-shop', 'zod', 'yaml', 'semver', 'js-yaml']

/** One roster entry, as `src/plugins/manager.ts` writes them. */
interface RosterEntry {
  name: string
  version: string
  enabled: boolean
  patch?: string
  hasClient: boolean
  bundleName?: string
  /** Marks the entry this deployment added, so it reads differently from the user's own. */
  default?: boolean
}

/** The roster file's shape. */
interface Roster {
  plugins: RosterEntry[]
}

/** The plugin module root the loader reads. Kept in step with `src/plugins/esm-loader.ts`. */
const PLUGIN_MODULES_ROOT = '/opt/dsh/plugins/node_modules'

/**
 * Install the default market into the roster, if it is not already there.
 *
 * The package files themselves are seeded by `scripts/assemble.ts`, which fails
 * the build rather than shipping a default that cannot boot.
 * @returns the roster entry that is now present, or undefined when the build carried no market.
 */
export function seedDefaultMarket(): RosterEntry | undefined {
  const manifestPath = `${PLUGIN_MODULES_ROOT}/${DEFAULT_MARKET}/package.json`
  if (!volume.exists(manifestPath)) {
    // A build without a vendored market is a supported build; say so once.
    console.warn('[market] no vendored market in this build; nothing to default to')
    return undefined
  }

  let roster: Roster = { plugins: [] }
  if (volume.exists(ROSTER_PATH)) {
    try {
      const parsed = JSON.parse(toText(volume.readFile(ROSTER_PATH))) as Roster
      roster = Array.isArray(parsed.plugins) ? parsed : { plugins: [] }
    } catch {
      // A corrupt roster is the manager's to recover from; do not clobber it here.
      console.warn('[market] roster is unreadable; leaving it to the plugin manager')
      return undefined
    }
  }
  // The user has already met the market — installed, disabled, or removed it.
  // Their roster is the record; a default that re-adds itself is not a default.
  const existing = roster.plugins.find(plugin => plugin.name === DEFAULT_MARKET)
  if (existing !== undefined) return existing

  const manifest = JSON.parse(toText(volume.readFile(manifestPath))) as {
    version?: string
    dsh?: { bundle?: { patch?: string }, client?: { platform?: string } }
  }
  const entry: RosterEntry = {
    name: DEFAULT_MARKET,
    version: manifest.version ?? '0.0.0',
    enabled: manifest.dsh?.bundle?.patch !== undefined,
    ...(manifest.dsh?.bundle?.patch === undefined ? {} : { patch: manifest.dsh.bundle.patch }),
    hasClient: manifest.dsh?.client?.platform === 'web',
    ...(manifest.dsh?.bundle === undefined ? {} : { bundleName: DEFAULT_MARKET }),
    default: true,
  }
  roster.plugins = [...roster.plugins, entry]
  volume.mkdirp(dirname(ROSTER_PATH))
  volume.writeFile(ROSTER_PATH, toBytes(JSON.stringify(roster, null, 2)))
  console.log(`[market] installed the default plugin market, ${DEFAULT_MARKET}@${entry.version}`)
  return entry
}

/** Every vendored package, for the build to assert against. */
export const VENDORED_PACKAGES: readonly string[] = VENDORED

/**
 * Declare `/opt/dsh` as the profile directory a plugin can discover.
 *
 * `dsh-plugin-shop` finds the harness profile it belongs to by walking up from
 * its own module file until it meets a directory that has both a `cordis.yml`
 * and a `package.json` whose `dsh.profile.bundles` is an array. `/opt/dsh` has
 * the first — it is this deployment's loader root — but not the second, so the
 * market disabled itself with "no profile directory found". On a real machine
 * that second half is the install record; here it is the bundle list this
 * build assembles, which is the same fact said in the same place.
 *
 * The file is only written when it is absent, so a future dsh that owns it
 * keeps it.
 */
export function declareProfileDirectory(bundles: readonly string[]): void {
  const manifestPath = '/opt/dsh/package.json'
  if (volume.exists(manifestPath)) return
  volume.writeFile(manifestPath, toBytes(JSON.stringify({
    name: 'dsh-web-deployment',
    private: true,
    type: 'module',
    description: 'The loader root of this browser build, declared the way a profile declares itself.',
    dsh: { profile: { bundles: [...bundles] } },
  }, null, 2)))
}
