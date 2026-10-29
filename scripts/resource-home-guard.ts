import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";

/** Attempts recorded by the child-process preload, including errors discovery might catch. */
export const ambientReads: string[] = [];
let active = process.env.PI_HOME_CANARY_CHILD === "1";

/** Allow the final omitted-home compatibility control to discover the disposable ambient decoy. */
export function stopAmbientGuard(): void {
	active = false;
}

// Preload BEFORE the loader links its named fs imports. Bun does not synchronize previously
// captured named imports when mock.method() changes the default fs object after linking.
if (active) {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) throw new Error("Resource-home canary requires a disposable ambient home");
	const roots = [join(home, ".agents"), join(home, ".pi", "agent")];
	for (const method of ["existsSync", "readdirSync", "readFileSync", "statSync", "realpathSync"] as const) {
		const original = fs[method];
		Object.defineProperty(fs, method, {
			value: (...args: unknown[]) => {
				const path = args[0];
				if (
					active &&
					typeof path === "string" &&
					roots.some((root) => path === root || path.startsWith(`${root}${sep}`))
				) {
					ambientReads.push(path);
					throw new Error(`Ambient resource access: ${path}`);
				}
				return Reflect.apply(original, fs, args);
			},
		});
	}
	syncBuiltinESMExports();
}
