import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

// 64KB is the pipe chunk size on Linux; a multibyte character straddling it used to decode to U+FFFD.
const script = `
const text = "a".repeat(65535) + "\\u00e9\\u{1F600}\\u00e9";
const bytes = Buffer.from(text);
const write = (stream) => {
  stream.write(bytes.subarray(0, 65536));
  setTimeout(() => stream.write(bytes.subarray(65536)), 50);
};
write(process.stdout);
write(process.stderr);
`;

describe("execCommand", () => {
	// Chunk-split multibyte output must not be corrupted.
	it("decodes a multibyte character split across stdout and stderr chunks", async () => {
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());
		const expected = `${"a".repeat(65535)}\u00e9\u{1F600}\u00e9`;
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(expected);
		expect(result.stderr).toBe(expected);
	});

	it("flushes a truncated trailing sequence as U+FFFD instead of dropping it", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", "process.stdout.write(Buffer.from([0x61, 0xc3]))"],
			process.cwd(),
		);
		expect(result.stdout).toBe("a\uFFFD");
	});
});
