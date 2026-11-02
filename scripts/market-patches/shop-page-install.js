		// ── browser-host patch (scripts/market-patches) ──────────────────────
		// This page has no `dsh` CLI and no pnpm: the two commands below would
		// fail with "jsh: command not found: dsh". The page does have an
		// installer of its own — `window.dsh.plugins`, which fetches the
		// package, unpacks it into the virtual filesystem and applies its
		// composition layer — so the same step is performed there instead.
		const pageInstaller = globalThis.dsh?.plugins;
		if (pageInstaller !== undefined && typeof pageInstaller.install === "function") {
			runInPageInstaller({
				installer: pageInstaller,
				verb: argv[0],
				spec: argv[1] ?? target,
				profile,
				log: append
			}).then((outcome) => {
				if (!outcome.ok) {
					state = "failed";
					detail = outcome.detail;
				} else {
					// The page composes its plugin tree at boot, so the new layer
					// takes effect on the next load rather than mid-session.
					activationOnDone = "restart";
					restartReason = "composition-is-fixed-at-boot";
					state = "done";
				}
				onStatus?.(status());
				resolve(status());
			});
			return;
		}
		beforeSpawn?.(env?.DSH_HOME);
		const { command, args } = dshCommand({