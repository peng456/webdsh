// Market patches applied to the vendored tree after unpacking.
//
// The vendored tree is build output: `--fetch` re-downloads and overwrites it,
// so a patch that lives only in the tree does not survive the next refresh.
// Add entries here instead. A patch belongs to the package it names, so the
// ones for a market this build does not ship are skipped rather than failing.
//
// Each patch is applied when its `find` matches exactly once. If it matches
// zero times and its replacement is already present, it counts as applied; if
// it matches any other way, the build fails loudly rather than silently
// shipping an unpatched (or doubly patched) market.

export const PATCHES = [
  {
    package: 'dsh-plugin',
    file: 'lib/http/catalog.js',
    why: "the market fetches its catalog through the host shell's curl, and this page's shell has no usable curl (-sS/-w/-o are rejected), so every catalog request 502s",
    find: '                const r = await fetchViaCurl(target, proxy, 20000);\n',
    replace: `                // browser-host patch (scripts/market-patches): the in-page shell
                // has no usable curl, so fetch directly — api.dsh-plugin.org
                // sends access-control-allow-origin: *, which permits it.
                let r;
                try {
                    const response = await fetch(target, { signal: AbortSignal.timeout(20000) });
                    r = { ok: response.ok, body: response.ok ? await response.text() : '', reason: null };
                }
                catch {
                    r = { ok: false, body: '', reason: null };
                }
`,
  },
  {
    package: 'zod',
    file: 'index.js',
    why: "zod v4's module graph is circular (v4/classic/iso.js <-> v4/classic/schemas.js) and the in-page loader cannot link ES-module cycles; every consumer of zod in this build uses only the builder API, so the entry is reduced to one file over zod/v4/core, and the cycles never enter the graph",
    find: 'import * as z from "./v4/classic/external.js";\nexport * from "./v4/classic/external.js";\nexport { z };\nexport default z;\n',
    replaceFile: 'zod-index.js',
  },
  {
    package: 'dsh-plugin-shop',
    file: 'lib/index.js',
    why: "the shop installs by shelling out to `dsh plugin --profile … add <spec>` via pnpm, and this page has neither a dsh CLI nor pnpm (it answers `jsh: command not found: dsh`); the page has its own installer over the virtual filesystem, so the helper below is inserted and the spawn site hands the work to it",
    find: 'function spawnPluginCli(options) {',
    // An insertion keeps its own anchor in the replacement, so "find" still
    // matches after the patch lands; this marker is what makes a re-run a no-op.
    marker: 'async function runInPageInstaller(options) {',
    replaceFile: 'shop-page-install-helpers.js',
  },
  {
    package: 'dsh-plugin-shop',
    file: 'lib/index.js',
    why: "the spawn site itself: route add/remove to the page installer before any dsh/pnpm process is started",
    find: '\t\tbeforeSpawn?.(env?.DSH_HOME);\n\t\tconst { command, args } = dshCommand({',
    marker: 'browser-host patch (scripts/market-patches) ──',
    replaceFile: 'shop-page-install.js',
  },
]
