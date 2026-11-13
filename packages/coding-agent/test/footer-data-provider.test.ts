import { execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() =>
						callback(
							resolvedBranch ? null : new Error("detached"),
							resolvedBranch ? `${resolvedBranch}\n` : "",
							"",
						),
					0,
				);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

function emitReftableChange(provider: FooterDataProvider): void {
	const { reftableWatcher } = provider as unknown as { reftableWatcher: FSWatcher | null };
	expect(reftableWatcher).not.toBeNull();
	reftableWatcher?.emit("change", "change", "tables.list");
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 3000,
	diagnostics?: () => Record<string, unknown>,
): Promise<void> {
	const startedAt = Date.now();
	let lastCheckedAt = startedAt;
	let maxCheckGapMs = 0;
	let checks = 0;
	while (!condition()) {
		const now = Date.now();
		checks++;
		maxCheckGapMs = Math.max(maxCheckGapMs, now - lastCheckedAt);
		lastCheckedAt = now;
		if (now - startedAt > timeoutMs) {
			const detail = diagnostics
				? `: ${JSON.stringify({ timeoutMs, elapsedMs: now - startedAt, checks, maxCheckGapMs, ...diagnostics() })}`
				: "";
			throw new Error(`Timed out waiting for condition${detail}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("footer wait failure diagnostics", () => {
	// #69: distinguish a missing refresh from an exact-count observation miss, not a root-cause regression.
	it.each([
		{ execFileCalls: 0, cachedBranch: "main", branchChangeCalls: 0 },
		{ execFileCalls: 2, cachedBranch: "foo", branchChangeCalls: 1 },
	])("preserves the exact-count deadline for $execFileCalls calls", async (snapshot) => {
		vi.useFakeTimers();
		try {
			const diagnostics = vi.fn(() => snapshot);
			const waiting = waitFor(() => snapshot.execFileCalls === 1, 10_000, diagnostics);
			const rejected = expect(waiting).rejects.toThrow(
				`Timed out waiting for condition: ${JSON.stringify({
					timeoutMs: 10_000,
					elapsedMs: 10_010,
					checks: 1002,
					maxCheckGapMs: 10,
					...snapshot,
				})}`,
			);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(diagnostics).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10);
			await rejected;
			expect(diagnostics).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not collect diagnostics on success", async () => {
		const diagnostics = vi.fn(() => ({}));
		await waitFor(() => true, 10_000, diagnostics);
		expect(diagnostics).not.toHaveBeenCalled();
	});
});

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	// Drive debounce behavior explicitly; native fs.watch delivery can race watcher startup.
	it("does not notify listeners when reftable updates keep the same branch", async () => {
		vi.useFakeTimers();
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			emitReftableChange(provider);
			await vi.advanceTimersByTimeAsync(501);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("debounces rapid reftable updates into a single async refresh", async () => {
		vi.useFakeTimers();
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(execFile).mockClear();

			emitReftableChange(provider);
			emitReftableChange(provider);
			emitReftableChange(provider);
			await vi.advanceTimersByTimeAsync(499);
			expect(vi.mocked(execFile)).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(2);
			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(650);
			// A real native event or stat poll tick may land during the settle window under load and
			// legitimately trigger one more refresh; the burst itself must coalesce, and a loop must not form.
			expect(vi.mocked(execFile).mock.calls.length).toBeLessThanOrEqual(2);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			// #69: capture the next natural failure without assuming why the historical wait timed out.
			const diagnostics = () => ({
				execFileCalls: vi.mocked(execFile).mock.calls.length,
				cachedBranch: provider.getGitBranch(),
				branchChangeCalls: onBranchChange.mock.calls.length,
				nativeCallbackTiming: "unknown",
				pollBaselineTiming: "unknown",
			});
			await waitFor(
				() => vi.mocked(execFile).mock.calls.length === 1,
				10_000,
				() => ({
					phase: "async git call count === 1",
					...diagnostics(),
				}),
			);
			await waitFor(
				() => provider.getGitBranch() === "foo",
				10_000,
				() => ({
					phase: "cached branch === foo",
					...diagnostics(),
				}),
			);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("retries git watchers 5 seconds after an async fs.watch error", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const providerWithInternals = provider as unknown as {
				headWatcher: FSWatcher | null;
			};
			const originalWatcher = providerWithInternals.headWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(providerWithInternals.headWatcher).not.toBeNull();
			expect(providerWithInternals.headWatcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});
