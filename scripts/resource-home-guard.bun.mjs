import { mock } from "bun:test";
import fs from "node:fs";
import "./resource-home-guard.ts";

// Bun's built-in named exports do not follow default-object mutations. Replace both
// specifiers before the loader links, retaining every unrelated fs export unchanged.
const observedFs = { ...fs, default: fs };
mock.module("node:fs", () => observedFs);
mock.module("fs", () => observedFs);
