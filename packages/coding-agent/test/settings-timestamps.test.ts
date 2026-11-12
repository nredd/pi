import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";

// nredd/pi#30: native timestamp settings obey normal persistence, precedence, and reload.
describe("showTimestamps settings", () => {
	it("defaults off and accepts only booleans in the schema", () => {
		expect(SettingsManager.inMemory().getShowTimestamps()).toBe(false);
		for (const showTimestamps of [true, false]) {
			expect(Value.Check(SettingsSchema, { showTimestamps })).toBe(true);
		}
		for (const showTimestamps of ["true", 1, null, {}, []]) {
			expect(Value.Check(SettingsSchema, { showTimestamps })).toBe(false);
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ showTimestamps }));
			expect(SettingsManager.fromStorage(storage).getShowTimestamps()).toBe(false);
		}
	});

	it("persists the native toggle without overwriting unrelated settings", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ theme: "dark" }));
		const manager = SettingsManager.fromStorage(storage);
		manager.setShowTimestamps(true);
		expect(manager.getShowTimestamps()).toBe(true);
		await manager.flush();
		expect(SettingsManager.fromStorage(storage).getShowTimestamps()).toBe(true);
		expect(manager.getTheme()).toBe("dark");
		manager.setShowTimestamps(false);
		await manager.flush();
		await manager.reload();
		expect(manager.getShowTimestamps()).toBe(false);
		expect(manager.drainErrors()).toEqual([]);
	});

	it("resolves project precedence after writes and reload, and ignores untrusted projects", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ showTimestamps: false }));
		const manager = SettingsManager.fromStorage(storage);
		manager.setShowTimestamps(true);
		expect(manager.getShowTimestamps()).toBe(false);
		await manager.flush();
		storage.withLock("project", () => JSON.stringify({ showTimestamps: true }));
		await manager.reload();
		expect(manager.getShowTimestamps()).toBe(true);
		manager.setShowTimestamps(false);
		expect(manager.getShowTimestamps()).toBe(true);
		manager.setProjectTrusted(false);
		expect(manager.getShowTimestamps()).toBe(false);
	});
});
