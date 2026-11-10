// Child-process fixture for http-dispatcher-upgrade.test.ts.
// Runs in its own process because configureHttpDispatcher() caches the installed
// global fetch, so it must start from Node's pristine globals.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import * as undici from "undici";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";

const payload = { ok: true, text: "compressed ".repeat(64) };
const encoders: Record<string, (body: Buffer) => Buffer> = {
	gzip: gzipSync,
	br: brotliCompressSync,
};

const server = http.createServer((request, response) => {
	const encoding = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
	const encode = encoders[encoding];
	if (!encode) {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "content-type": "application/json", "content-encoding": encoding });
	response.end(encode(Buffer.from(JSON.stringify(payload))));
});

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	configureHttpDispatcher();
	for (const fetchImpl of [undici.fetch, globalThis.fetch]) {
		for (const encoding of Object.keys(encoders)) {
			const response = await fetchImpl(`http://127.0.0.1:${port}/${encoding}`);
			assert.deepStrictEqual(await response.json(), payload);
		}
	}
} finally {
	await undici.getGlobalDispatcher().close();
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log("compression-ok");
