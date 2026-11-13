import { execFile } from "child_process";
import type * as FS from "fs";
import { mkdirSync, mkdtempSync, rmSync, type Stats, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sampling = vi.hoisted(() => ({
	callbacks: [] as Array<(error: NodeJS.ErrnoException | null, stats: Stats) => void>,
	baselineError: false,
	watchers: [] as Array<{ path: string; listener: () => void }>,
}));
vi.mock("fs", async (importOriginal) => {
	const original = await importOriginal<typeof FS>();
	return {
		...original,
		statSync: vi.fn((path: string) => {
			if (sampling.baselineError && path.endsWith("tables.list")) throw new Error("baseline unavailable");
			return original.statSync(path);
		}),
		stat: vi.fn((_path: string, callback: (error: NodeJS.ErrnoException | null, stats: Stats) => void) => {
			sampling.callbacks.push(callback);
		}),
	};
});
vi.mock("../src/utils/fs-watch.ts", () => ({
	FS_WATCH_RETRY_DELAY_MS: 5000,
	watchWithErrorHandler: vi.fn((path: string, listener: () => void) => {
		sampling.watchers.push({ path, listener });
		return { close: vi.fn() };
	}),
	closeWatcher: (watcher: { close(): void } | null) => watcher?.close(),
}));
vi.mock("child_process", () => ({
	spawnSync: vi.fn(() => ({ status: 0, stdout: "main\n" })),
	execFile: vi.fn(
		(_command: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
			callback(null, "foo\n");
		},
	),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

// #69: Exercise poll failures/lifecycle independently of native delivery and real-FS startup coverage.
describe("reftable poll lifecycle", () => {
	let root: string;
	const providers: FooterDataProvider[] = [];
	function repo(name: string): string {
		const cwd = join(root, name);
		mkdirSync(join(cwd, ".git", "reftable"), { recursive: true });
		writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
		writeFileSync(join(cwd, ".git", "reftable", "tables.list"), "0\n");
		return cwd;
	}
	function provider(cwd: string): FooterDataProvider {
		const result = new FooterDataProvider(cwd);
		providers.push(result);
		expect(result.getGitBranch()).toBe("main");
		return result;
	}
	function sample(cwd: string, changed = false): void {
		const stats = statSync(join(cwd, ".git", "reftable", "tables.list"));
		const callback = sampling.callbacks.shift();
		expect(callback).toBeDefined();
		callback?.(null, changed ? Object.assign(stats, { size: stats.size + 1 }) : stats);
	}
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		sampling.callbacks.length = 0;
		sampling.baselineError = false;
		sampling.watchers.length = 0;
		root = mkdtempSync(join(tmpdir(), "footer-poll-"));
	});
	afterEach(() => {
		for (const item of providers.splice(0)) item.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	it("does not overlap samples or refresh unchanged metadata, and debounces a change exactly once", async () => {
		const cwd = repo("first");
		const footer = provider(cwd);
		const notify = vi.fn();
		footer.onBranchChange(notify);
		await vi.advanceTimersByTimeAsync(1000);
		expect(sampling.callbacks).toHaveLength(1);
		sample(cwd);
		await vi.advanceTimersByTimeAsync(250);
		expect(execFile).not.toHaveBeenCalled();
		sample(cwd, true);
		await vi.advanceTimersByTimeAsync(499);
		expect(execFile).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(footer.getGitBranch()).toBe("foo");
		expect(notify).toHaveBeenCalledTimes(1);
		// The refresh adopted current metadata as the baseline; the same metadata again is not a change.
		sample(cwd);
		await vi.advanceTimersByTimeAsync(1000);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("refreshes the poll baseline when a watcher-triggered refresh starts, so one mutation spawns one git process", async () => {
		const cwd = repo("first");
		const footer = provider(cwd);
		const tables = join(cwd, ".git", "reftable", "tables.list");
		const watcher = sampling.watchers.find(({ path }) => path.endsWith("tables.list"));
		expect(watcher).toBeDefined();
		writeFileSync(tables, "01\n");
		watcher?.listener();
		await vi.advanceTimersByTimeAsync(500);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(footer.getGitBranch()).toBe("foo");
		// The poll's first sample sees the same mutation the native watcher already handled.
		await vi.advanceTimersByTimeAsync(250);
		sample(cwd);
		await vi.advanceTimersByTimeAsync(1000);
		expect(execFile).toHaveBeenCalledTimes(1);
		// A later mutation is still detected.
		writeFileSync(tables, "012\n");
		sample(cwd);
		await vi.advanceTimersByTimeAsync(500);
		expect(execFile).toHaveBeenCalledTimes(2);
	});

	it.each(["ENOENT", "EACCES"])("retries a %s sample error after exactly five seconds", async (code) => {
		const cwd = repo("first");
		provider(cwd);
		await vi.advanceTimersByTimeAsync(250);
		const callback = sampling.callbacks.shift();
		expect(callback).toBeDefined();
		callback?.(Object.assign(new Error(code), { code }), statSync(join(cwd, ".git", "reftable", "tables.list")));
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(4999);
		expect(sampling.callbacks).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(250);
		expect(sampling.callbacks).toHaveLength(1);
		sample(cwd, true);
		await vi.advanceTimersByTimeAsync(500);
		expect(execFile).toHaveBeenCalledTimes(1);
	});

	it("retries an unavailable synchronous baseline without retaining a poll timer", async () => {
		const cwd = repo("first");
		sampling.baselineError = true;
		provider(cwd);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(4999);
		expect(sampling.callbacks).toHaveLength(0);
		sampling.baselineError = false;
		await vi.advanceTimersByTimeAsync(251);
		expect(sampling.callbacks).toHaveLength(1);
	});

	it.each([false, true])("ignores an in-flight sample after disposal (error=%s)", async (error) => {
		const cwd = repo("first");
		const footer = provider(cwd);
		await vi.advanceTimersByTimeAsync(250);
		footer.dispose();
		if (error) sampling.callbacks.shift()?.(new Error("late error"), statSync(join(cwd, ".git")));
		else sample(cwd, true);
		await vi.advanceTimersByTimeAsync(6000);
		expect(execFile).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])("ignores an old-root sample after retargeting (error=%s)", async (error) => {
		const first = repo("first");
		const second = repo("second");
		const footer = provider(first);
		await vi.advanceTimersByTimeAsync(250);
		footer.setCwd(second);
		expect(footer.getGitBranch()).toBe("main");
		if (error) sampling.callbacks.shift()?.(new Error("late error"), statSync(join(first, ".git")));
		else sample(first, true);
		await vi.advanceTimersByTimeAsync(500);
		expect(execFile).not.toHaveBeenCalled();
		expect(sampling.callbacks).toHaveLength(1);
		sample(second, true);
		await vi.advanceTimersByTimeAsync(500);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile).toHaveBeenCalledWith(
			"git",
			expect.any(Array),
			expect.objectContaining({ cwd: second }),
			expect.any(Function),
		);
		expect(footer.getGitBranch()).toBe("foo");
	});
});
