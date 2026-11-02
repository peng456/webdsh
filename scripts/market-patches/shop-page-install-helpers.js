/**
 * Run one plugin add/remove through this page's own installer.
 *
 * The shop shells out to `dsh plugin --profile … add <spec>`, which needs a dsh
 * CLI and pnpm. Neither exists in this page; `window.dsh.plugins` is the same
 * step over the virtual filesystem. The profile manifest is kept in step with
 * what was installed, because that is the file the shop reads to know what is
 * installed and to confirm an install landed.
 */
async function runInPageInstaller(options) {
	const { installer, verb, spec, log } = options;
	const note = (line) => {
		try { log(line) } catch {}
	};
	try {
		if (verb === "add") {
			note(`[page] installing ${spec} through this page's installer`);
			const entry = await installer.install(spec);
			const version = typeof entry?.version === "string" ? entry.version : "0.0.0";
			const name = typeof entry?.name === "string" ? entry.name : spec;
			pageRememberDependency(name, version);
			note(`[page] installed ${name}@${version}; reload the page to apply its composition layer`);
			return { ok: true };
		}
		if (verb === "remove") {
			note(`[page] removing ${spec} through this page's installer`);
			await installer.remove(spec);
			pageForgetDependency(spec);
			note(`[page] removed ${spec}`);
			return { ok: true };
		}
		return {
			ok: false,
			detail: `this page's installer handles add and remove; the shop asked for "${String(verb)}", which needs a dsh CLI this build does not have`
		};
	} catch (error) {
		return { ok: false, detail: `install failed in this page: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** The directory of the profile this page declares — the loader root. */
function pageProfileRoot() {
	try { return discoverProfile(fileURLToPath(import.meta.url), void 0).dir } catch {}
	return existsSync("/opt/dsh/cordis.yml") ? "/opt/dsh" : void 0;
}

/** Read the profile manifest, or undefined when it is absent or unreadable. */
function pageReadManifest() {
	const dir = pageProfileRoot();
	if (dir === void 0) return void 0;
	try { return { dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) } } catch { return void 0 }
}

/** Write the profile manifest back, best effort. */
function pageWriteManifest(read) {
	try { writeFileSync(join(read.dir, "package.json"), JSON.stringify(read.manifest, null, 2)) } catch {}
}

/** Record an installed package where the shop looks for one. */
function pageRememberDependency(name, version) {
	const read = pageReadManifest();
	if (read === void 0) return;
	read.manifest.dependencies = { ...(read.manifest.dependencies ?? {}), [name]: version };
	pageWriteManifest(read);
}

/** Drop a removed package from the same record. */
function pageForgetDependency(name) {
	const read = pageReadManifest();
	if (read === void 0) return;
	if (read.manifest.dependencies !== undefined) delete read.manifest.dependencies[name];
	pageWriteManifest(read);
}
function spawnPluginCli(options) {