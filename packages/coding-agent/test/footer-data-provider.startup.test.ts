// #69: Real filesystem startup regression, with no watcher/stat mocks.
import type * as Child from "node:child_process";
import { pbkdf2 } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const replies = vi.hoisted(() => ({ branches: new Map<string, string>(), calls: new Map<string, number>() }));
vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof Child>()),
	spawnSync: vi.fn((_command: string, _args: string[], opts: { cwd: string }) => ({
		status: 0,
		stdout: `${replies.branches.get(opts.cwd) ?? "main"}\n`,
	})),
	execFile: vi.fn(
		(
			_command: string,
			_args: string[],
			opts: { cwd: string },
			callback: (error: Error | null, stdout: string) => void,
		) => {
			replies.calls.set(opts.cwd, (replies.calls.get(opts.cwd) ?? 0) + 1);
			setTimeout(() => callback(null, `${replies.branches.get(opts.cwd) ?? "main"}\n`), 0);
		},
	),
}));

import { FooterDataProvider } from "../src/core/footer-data-provider.ts";

it("recovers the first reftable update when initial asynchronous stat sampling is late", async () => {
	const root = mkdtempSync(join(tmpdir(), "footer-startup-"));
	// Queue real work ahead of the first async stat on every libuv worker. Unlike a FIFO,
	// crypto needs no external executable and works on Windows too. test.sh uses the default pool.
	const poolSize = Number(process.env.UV_THREADPOOL_SIZE) || 4;
	const pending = Array.from(
		{ length: poolSize },
		() =>
			new Promise<void>((resolve, reject) => {
				pbkdf2("footer", "startup", 2_000_000, 32, "sha256", (error) => (error ? reject(error) : resolve()));
			}),
	);
	const fixtures: Array<{ provider: FooterDataProvider; cwd: string; notices: number }> = [];
	try {
		for (let index = 0; index < 32; index++) {
			const base = join(root, String(index));
			const common = join(base, "repo", ".git");
			const git = join(common, "worktrees", "src");
			const cwd = join(base, "worktree");
			const tables = join(common, "reftable", "tables.list");
			mkdirSync(git, { recursive: true });
			mkdirSync(join(common, "reftable"), { recursive: true });
			mkdirSync(cwd);
			writeFileSync(join(cwd, ".git"), `gitdir: ${git}\n`);
			writeFileSync(join(git, "HEAD"), "ref: refs/heads/.invalid\n");
			writeFileSync(join(git, "commondir"), "../..\n");
			writeFileSync(tables, "0\n");
			replies.branches.set(cwd, "main");
			const provider = new FooterDataProvider(cwd);
			const fixture = { provider, cwd, notices: 0 };
			fixtures.push(fixture);
			provider.onBranchChange(() => fixture.notices++);
			expect(provider.getGitBranch()).toBe("main");
			replies.branches.set(cwd, "foo");
			writeFileSync(tables, "1\n");
		}
		await Promise.all(pending);
		const start = Date.now();
		while (fixtures.some(({ provider }) => provider.getGitBranch() !== "foo") && Date.now() - start <= 10_000) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const stalled = fixtures.filter(({ provider }) => provider.getGitBranch() !== "foo");
		expect(stalled.length).toBe(0);
		for (const fixture of fixtures) {
			// The native watcher and the stat poll (separate baseline, see `pollReftableTablesList`) can each
			// observe the one mutation, so one or two refreshes is expected. Zero means the update was lost.
			const calls = replies.calls.get(fixture.cwd) ?? 0;
			expect(calls).toBeGreaterThanOrEqual(1);
			expect(calls).toBeLessThanOrEqual(2);
			expect(fixture.provider.getGitBranch()).toBe("foo");
			expect(fixture.notices).toBe(1);
		}
	} finally {
		await Promise.all(pending);
		for (const fixture of fixtures) fixture.provider.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 15_000);
