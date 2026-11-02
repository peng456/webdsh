/**
 * The LAN scanner's host half.
 *
 * It does nothing, and it has to exist: a `dsh.client` declaration is only read
 * from a package that is *in* the composition, so the browser half — which is
 * the whole plugin — needs a host row to hang from. Probing the network is
 * something a page can do by itself, so there is nothing to hand to the host.
 */

/** Stable Cordis plugin name. */
export const name = 'web-lanscan'

/** Mount the host half. There is no host-side behaviour to mount. */
export function apply(): void {}

export default { name, apply }
