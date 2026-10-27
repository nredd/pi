// Child-process fixture for http-dispatcher-upgrade.test.ts.
// Upstream GHSA-xjj6-f33q-929c (undici): more than 5 Content-Encoding values
// followed by an early FIN must reject the fetch, not crash the process. No
// uncaughtException handler is installed and success is printed only after all
// cleanup: the parent treats a crash, even a late one, as a non-zero exit.
import assert from "node:assert/strict";
import net, { type AddressInfo } from "node:net";
import * as undici from "undici";
import { configureHttpDispatcher } from "../../src/core/http-dispatcher.ts";

const sockets = new Set<net.Socket>();
const server = net.createServer((socket) => {
	sockets.add(socket);
	socket.on("close", () => sockets.delete(socket));
	socket.on("error", () => {});
	socket.once("data", () => {
		// Six encodings, promised body, then FIN before any body bytes.
		socket.end(
			"HTTP/1.1 200 OK\r\ncontent-encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\ncontent-length: 100\r\n\r\n",
		);
	});
});

try {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	configureHttpDispatcher();
	for (const fetchImpl of [undici.fetch, globalThis.fetch]) {
		await assert.rejects(
			async () => (await fetchImpl(`http://127.0.0.1:${port}/`)).text(),
			(error: unknown) =>
				error instanceof TypeError &&
				error.cause instanceof Error &&
				error.cause.message === "too many content-encodings in response: 6, maximum allowed is 5",
		);
	}
} finally {
	await undici.getGlobalDispatcher().close();
	for (const socket of sockets) socket.destroy();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
console.log("flood-rejected-ok");
