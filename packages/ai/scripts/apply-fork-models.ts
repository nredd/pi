#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyModel } from "../src/types.ts";
import { forkModels } from "./fork-models.ts";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataStructure,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const providersDir = join(packageRoot, "src/providers");
const dataDir = join(providersDir, "data");

// Reject corrupt inputs before recomputing hashes. Never make invalid frozen data appear valid.
validateGeneratedModelData(packageRoot);
const structure = readModelDataStructure(packageRoot);
const files = Object.fromEntries(
	Object.keys(structure).map((provider) => [
		`${provider}.json`,
		readFileSync(join(dataDir, `${provider}.json`), "utf8"),
	]),
);
let changed = false;
for (const provider of ["openai", "openai-codex"] as const) {
	const filename = `${provider}.json`;
	const groups: Record<string, Record<string, AnyModel>> = JSON.parse(files[filename]);
	let providerChanged = false;
	for (const model of forkModels(provider)) {
		const key = `chat:${model.id}`;
		if (JSON.stringify(groups[model.api]?.[key]) === JSON.stringify(model)) continue;
		// Do not silently relocate an existing identity from a different API group.
		if (structure[provider][key] && structure[provider][key] !== model.api)
			throw new Error(`Unexpected API for ${provider}/${key}`);
		groups[model.api] ??= {};
		groups[model.api][key] = model;
		structure[provider][key] = model.api;
		providerChanged = true;
	}
	if (providerChanged) {
		files[filename] = `${JSON.stringify(groups)}\n`;
		changed = true;
	}
}

if (changed) {
	const manifest = JSON.parse(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8"));
	const staging = mkdtempSync(join(providersDir, ".fork-models-"));
	const stagedData = join(staging, "data");
	const previousData = join(staging, "previous");
	try {
		mkdirSync(stagedData);
		for (const [filename, content] of Object.entries(files)) writeFileSync(join(stagedData, filename), content);
		// Preserve the frozen catalog's generation time, so identical input produces identical bytes.
		writeFileSync(
			join(stagedData, MODEL_DATA_MANIFEST_FILE),
			`${JSON.stringify(createModelDataManifest(structure, files, manifest.generatedAt))}\n`,
		);
		validateModelDataDirectory(structure, stagedData);
		renameSync(dataDir, previousData);
		try {
			renameSync(stagedData, dataDir);
		} catch (error) {
			renameSync(previousData, dataDir);
			throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}
console.log(changed ? "Applied frozen fork model additions." : "Frozen fork model additions already present.");
