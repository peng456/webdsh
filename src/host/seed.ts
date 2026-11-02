/**
 * Seed the virtual filesystem with the deployment's own files and a usable
 * POSIX skeleton.
 *
 * Seeding is idempotent and never clobbers user content: deployment files under
 * `/opt/dsh` are rewritten on every boot (they belong to the build), while the
 * home and workspace directories are only created when missing, so a returning
 * visitor keeps their sessions, settings, and files.
 */

import { SEED_FILES, SEED_REVISION } from '../generated/seed-files.ts'
import { MODEL_CATALOG_PATCH } from '../generated/model-catalog.ts'
import { volume } from '../vfs/volume.ts'
import { toBytes, toText } from '../node/binary.ts'
import { env } from '../node/process.ts'
import browserPatchSource from './browser.patch.yml?raw'
import machinePatchSource from '../../packages/dsh-web-machine/cordis.patch.yml?raw'
import installPatchSource from '../../packages/dsh-web-plugins/cordis.patch.yml?raw'
import starPatchSource from '../../packages/dsh-web-star/cordis.patch.yml?raw'
import networkPatchSource from '../../packages/dsh-web-network/cordis.patch.yml?raw'
import filesPatchSource from '../../packages/dsh-web-files/cordis.patch.yml?raw'
import lanscanPatchSource from '../../packages/dsh-web-lanscan/cordis.patch.yml?raw'
import { selectedGuest } from '../runtime/selection.ts'
import { declareProfileDirectory, seedDefaultMarket } from '../plugins/default-market.ts'

/**
 * Bundle layers for the plugins this repository ships.
 *
 * They are layers rather than edits to the overlay for the same reason a
 * plugin carries its own `cordis.patch.yml` on a machine: the surface should
 * not have to know they exist, and removing one should be removing one file.
 */
const SHIPPED_PLUGIN_PATCHES: Record<string, string> = {
  'web-machine': machinePatchSource,
  'web-plugin-install': installPatchSource,
  'web-star': starPatchSource,
  'web-network': networkPatchSource,
  'web-files': filesPatchSource,
  'web-lanscan': lanscanPatchSource,
}

/** The bundle layers this build lays down, in application order. */
export const SHIPPED_BUNDLES = ['browser', ...Object.keys(SHIPPED_PLUGIN_PATCHES)]

/** Root the build's own files live under. */
export const DEPLOY_ROOT = '/opt/dsh'

/**
 * Marks a seed row whose contents are base64 rather than UTF-8 text.
 *
 * The seed table is a list of strings, and the vendored market's files are JS
 * bundles whose bytes do not survive a UTF-8 round-trip. `scripts/assemble.ts`
 * writes those rows with this prefix.
 */
const BINARY_PREFIX = 'b64:'

/**
 * Where the user's files live.
 *
 * This is the runtime's own working directory, not a path invented for it: the
 * container roots every path at that directory, so a workspace anywhere else
 * ends up nested inside it and its snapshot cannot be addressed. It sits
 * directly under the home the picker opens at, so a first-time visitor sees it
 * without navigating anywhere.
 */
export const WORKSPACE_ROOT = '/home/dsh/workspace'

/** Directories a POSIX-shaped world is expected to have. */
const SKELETON = [
  '/bin', '/usr/bin', '/usr/local/bin', '/etc', '/tmp', '/var', '/var/log',
  '/home', '/home/dsh', WORKSPACE_ROOT, '/opt', DEPLOY_ROOT,
]


/**
 * A stub executable for each command the shell implements internally. `bash`
 * exists as a real file because `dsh-bash-sandbox` resolves the executable
 * through the subprocess seam before spawning it, and an absent `/bin/bash`
 * would refuse the tool rather than run it.
 */
const SHELL_STUBS = ['sh', 'bash', 'env', 'node', 'git']

/** Marker recording which build's seed table the filesystem already carries. */
const SEED_MARKER = `${DEPLOY_ROOT}/.seed-revision`

/**
 * Files that belong to the build and are refreshed when the build changes.
 *
 * The whole table used to be written on every boot. That is correct but not
 * free: this deployment's table includes the vendored market, so each open
 * decoded ~10 MB of base64 and wrote 1092 files into the virtual filesystem.
 * The marker makes the refresh conditional on the table actually differing,
 * which is the same guarantee for a user who changed nothing and far less work.
 */
function writeDeploymentFiles(): void {
  const stale = !volume.exists(SEED_MARKER) || toText(volume.readFile(SEED_MARKER)).trim() !== SEED_REVISION
  if (stale) {
    for (const [path, contents] of SEED_FILES) {
      volume.mkdirp(path.slice(0, path.lastIndexOf('/')))
      // A `b64:` row is a binary file (the vendored market's bundles); every
      // other row is text and is written as UTF-8. The prefix is the build's, not
      // a plugin's, so it is checked before anything is decoded.
      volume.writeFile(path, contents.startsWith(BINARY_PREFIX)
        ? toBytes(contents.slice(BINARY_PREFIX.length), 'base64')
        : toBytes(contents))
    }
  }
  // This deployment's own overlay layer, alongside the upstream bundle patches.
  // The authored rows first, then the generated provider roster: one layer,
  // because they are one deployment's answer, and the generated half is
  // appended rather than interleaved so the authored file stays readable.
  volume.mkdirp(`${DEPLOY_ROOT}/bundles/browser`)
  volume.writeFile(
    `${DEPLOY_ROOT}/bundles/browser/cordis.patch.yml`,
    toBytes(`${browserPatchSource}\n${MODEL_CATALOG_PATCH}`),
  )
  // The plugins this build ships are laid down as ordinary bundle layers, one
  // directory each, so the composition reads them exactly as it reads a plugin
  // someone installed.
  for (const [name, source] of Object.entries(SHIPPED_PLUGIN_PATCHES)) {
    volume.mkdirp(`${DEPLOY_ROOT}/bundles/${name}`)
    volume.writeFile(`${DEPLOY_ROOT}/bundles/${name}/cordis.patch.yml`, toBytes(source))
  }
  // The empty root the include composes the patch layers over.
  volume.writeFile(`${DEPLOY_ROOT}/cordis.yml`, toBytes('[]\n'))
  if (stale) volume.writeFile(SEED_MARKER, toBytes(`${SEED_REVISION}\n`))
}

/** Directories and stub binaries, created only when absent. */
function writeSkeleton(): void {
  for (const directory of SKELETON) volume.mkdirp(directory)
  for (const name of SHELL_STUBS) {
    const path = `/bin/${name}`
    if (volume.exists(path)) continue
    volume.writeFile(
      path,
      toBytes(`#!/bin/sh\n# ${name} is implemented by the in-browser shell; this file exists so executable lookup succeeds.\n`),
      0o755,
    )
    if (!volume.exists(`/usr/bin/${name}`)) volume.symlink(`/bin/${name}`, `/usr/bin/${name}`)
  }
  const home = env.HOME ?? '/home'
  volume.mkdirp(`${home}/.dsh`)
  if (!volume.exists(`${WORKSPACE_ROOT}/README.md`)) {
    volume.writeFile(`${WORKSPACE_ROOT}/README.md`, toBytes(workspaceReadme()))
  }
}

/**
 * The starter file a first-time visitor finds in the default workspace.
 *
 * Written for the machine this session actually runs. The agent reads this
 * directory, so the file is not only documentation for a person: a session on
 * an emulated PC that found "Node and npm — install a package from the
 * registry" here would have a workspace contradicting its own system prompt,
 * in a file it is likely to open first.
 * @returns the README's text.
 */
function workspaceReadme(): string {
  const guest = selectedGuest()
  const shared = `# Workspace

This is a virtual filesystem that lives in your browser. Files you and the agent
create here persist across reloads (they are stored in IndexedDB for this
origin) and are private to this browser — nothing is uploaded anywhere.
`
  if (guest !== undefined) {
    return `${shared}
This session runs an emulated PC — ${guest.name} — and this directory is **not**
its disk. The two share nothing: the agent's file tools read and write here, and
its machine tools drive a computer with a filesystem of its own. The Runtime
panel in the sidebar is where that choice is made, and where you can watch the
machine and type at it.

Things that work here:

- reading, writing, searching, and editing files
- taking files in and out of the tab, through the Files panel

Things that do not:

- Node, npm, Python, or a shell — this session has none; the emulated machine
  has whatever its own operating system came with
`
  }
  return `${shared}
The agent and the terminal share this directory: a file either of them creates,
the other sees immediately.

Things that work here:

- reading, writing, searching, and editing files
- Node and npm — install a package from the registry and import it
- a shell for running them, and the common file commands

Things that do not:

- native toolchains (a compiler, python, a system package manager)
- listening on a port, or reaching a host that refuses cross-origin reads
`
}

/** Populate the virtual filesystem. Safe to call once per boot. */
export function seedFilesystem(): void {
  writeSkeleton()
  writeDeploymentFiles()
  // A plugin that looks for the profile it belongs to finds this one.
  declareProfileDirectory(SHIPPED_BUNDLES)
  // The packages are seeded; this is the one piece of user state a default has
  // to write, and it refuses to do so once the user has an opinion.
  seedDefaultMarket()
}
