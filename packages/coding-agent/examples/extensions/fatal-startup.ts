/**
 * Fatal Startup Extension
 *
 * Fails session startup on purpose. Pi normally logs a `session_start` handler error and
 * continues; throwing `ExtensionStartupError` is the one exception. Print mode exits nonzero,
 * RPC mode never accepts commands, the TUI exits, and SDK `bindExtensions()` rejects, all
 * before any provider request.
 *
 * Usage: pi -e examples/extensions/fatal-startup.ts, with a `.pi/required.txt` missing.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, ExtensionStartupError } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const required = join(ctx.cwd, ".pi", "required.txt");
		if (!existsSync(required)) {
			throw new ExtensionStartupError(`Missing ${required}`);
		}
	});
}
