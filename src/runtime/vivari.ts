/**
 * The runtime handle the rest of the harness codes against.
 *
 * These are the shapes `webcontainer.ts` needs, stated once here so the module
 * can be pointed at a different engine without touching its callers: a
 * filesystem, a `spawn` that streams, and the two snapshot calls the persistence
 * layer uses. They are structurally the subset of `@webcontainer/api` this app
 * actually calls, so swapping the implementation is a change of import.
 */
export interface RuntimeProcess {
  /** Merged stdout + stderr, as a terminal would show it. */
  output: ReadableStream<string>
  /** Standard input. Closing it sends EOF. */
  input: WritableStream<string>
  /** Resolves with the exit code. */
  exit: Promise<number>
  /** Terminate the process. */
  kill(): void
}

/** The filesystem calls the harness makes. */
export interface RuntimeFs {
  writeFile(path: string, contents: string | Uint8Array): Promise<void>
  readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  rm(path: string, options?: { recursive?: boolean, force?: boolean }): Promise<void>
  readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | { name: string, isDirectory(): boolean, isFile(): boolean }[]>
  stat(path: string): Promise<{ size: number, isDirectory(): boolean, isFile(): boolean }>
  exists(path: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
}

/** A booted engine. */
export interface RuntimeHandle {
  fs: RuntimeFs
  /** The engine's default `PATH`, or `''` to let it keep its own. */
  path: string
  spawn(
    command: string,
    args: string[],
    options?: { cwd?: string, env?: Record<string, string>, signal?: AbortSignal },
  ): Promise<RuntimeProcess>
}

/** What went wrong, in the engine's own words, for the boot error path. */
let lastError: string | undefined

/**
 * Boot Vivari, the engine this build runs Node in.
 *
 * Vivari is an open-source (MIT) WebContainer: a virtual filesystem persisted to
 * OPFS, Node's own `lib/` JavaScript running in workers, a real process model,
 * and the real npm/wrapper package managers. It exists here because the
 * proprietary alternative boots by loading a frame from a third party's origin,
 * which is both a dependency this deployment cannot ship and — on the networks
 * this build is used from — an address that answers 404.
 *
 * Every asset it needs (kernel, process and filesystem workers, the Wasm VFS)
 * is served from this same origin, so a boot costs one round trip to the box the
 * page came from and nothing else. `vendor/npm-pack.bin` beside them is npm
 * itself, which the kernel unpacks on first `npm`/`npx`.
 * @returns the booted handle.
 */
export async function bootVivari(): Promise<RuntimeHandle> {
  const { Vivari } = await import('@vivari/core')
  // No preview Service Worker: this app has its own at the origin root for
  // plugin-owned routes, and previews are a studio feature nothing here uses.
  const vivari = await Vivari.boot({ serviceWorkerUrl: false })
  lastError = undefined
  const handle: RuntimeHandle = {
    fs: {
      writeFile: (path, contents) => vivari.fs.writeFile(path, contents),
      readFile: (path, encoding) => vivari.fs.readFile(path, encoding),
      mkdir: (path, options) => vivari.fs.mkdir(path, options),
      rm: (path, options) => vivari.fs.rm(path, options),
      // `withFileTypes` has to travel: the filesystem bridge asks for entry
      // kinds, and a call that silently drops the flag hands it strings, whose
      // `.isDirectory()` is not a function — which is what made listing
      // `/home/dsh` fail with ENOENT.
      readdir: (path, options) => options?.withFileTypes === true
        ? vivari.fs.readdir(path, { withFileTypes: true })
        : vivari.fs.readdir(path),
      stat: (path) => vivari.fs.stat(path),
      exists: (path) => vivari.fs.exists(path),
      rename: (from, to) => vivari.fs.rename(from, to),
    },
    // Empty on purpose: Vivari puts its own `PATH` in place (and prepends a
    // project's `node_modules/.bin` per spawn). Overwriting it from here is how
    // `npm` stops resolving, so the shell's `PATH` is left to the engine.
    path: '',
    async spawn(command, args, options = {}) {
      const process = await vivari.spawn(command, args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      return {
        output: process.output,
        input: process.input,
        exit: process.exit,
        kill: () => { process.kill() },
      }
    },
  }
  return handle
}

/** The last boot error, once a boot has failed. */
export function vivariFailure(): string | undefined {
  return lastError
}
