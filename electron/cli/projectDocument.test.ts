import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { parseProjectDocument } from "./projectDocument";

describe("parseProjectDocument", () => {
	it("recognizes legacy project documents without changing their extra fields", () => {
		const raw = {
			version: 2,
			media: { screenVideoPath: "/tmp/screen.mp4" },
			editor: { aspectRatio: "16:9" },
			pluginMetadata: { kept: true },
		};

		const loaded = parseProjectDocument(raw);
		expect(loaded.kind).toBe("legacy");
		if (loaded.kind === "legacy") expect(loaded.document).toEqual(raw);
	});

	it.each([
		3, 4, 5, 6, 7,
	])("migrates and validates supported Axcut schema version %i", (schemaVersion) => {
		const current = createEmptyDocument({
			projectId: "project-1",
			title: "Migrated",
			createdAt: "2026-08-11T00:00:00.000Z",
		});
		const raw = { ...current, schemaVersion };

		const loaded = parseProjectDocument(raw);
		expect(loaded.kind).toBe("current");
		if (loaded.kind === "current") expect(loaded.document.schemaVersion).toBe(7);
	});

	it("rejects unsupported Axcut versions with a clear error", () => {
		expect(() => parseProjectDocument({ schemaVersion: 8 })).toThrow(
			"Unsupported Axcut schemaVersion 8; supported versions are 3 through 7",
		);
	});

	it("rejects malformed current and unknown project shapes clearly", () => {
		expect(() => parseProjectDocument({ schemaVersion: 7, project: "broken" })).toThrow(
			/Invalid Axcut project document/,
		);
		expect(() => parseProjectDocument({ unrelated: true })).toThrow(
			/Unrecognized OpenScreen project document/,
		);
		expect(() => parseProjectDocument({ version: 2, media: { screenVideoPath: 42 } })).toThrow(
			/Invalid legacy OpenScreen project document/,
		);
	});
});
