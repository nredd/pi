/**
 * Thrown from a `session_start` handler to fail session startup on purpose.
 *
 * Any other error a `session_start` handler throws is logged and startup continues. This one is the explicit
 * exception: `AgentSession.bindExtensions()` and `reload()` reject with it, the session refuses
 * to send requests until a later bind or reload succeeds, and the CLI modes exit nonzero before
 * any provider request. Use it when continuing would be unsafe, e.g. required trusted
 * configuration failed validation.
 */
export class ExtensionStartupError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ExtensionStartupError";
	}
}

/**
 * True for an `ExtensionStartupError` from this or another copy of the package.
 * An extension that bundles its own copy of the SDK defeats `instanceof`, so the name counts too.
 */
export function isExtensionStartupError(error: unknown): error is ExtensionStartupError {
	return error instanceof ExtensionStartupError || (error instanceof Error && error.name === "ExtensionStartupError");
}
