import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
} from "../../src/lib/ai-edition/schema";
import { type PackedProjectData, runInfoCommand, runPackCommand } from "./projectCommands";

let root = "";

/** Absolute path inside the throwaway root, parents created. */
async function make(relative: string, contents = "video-bytes"): Promise<string> {
	const target = path.join(root, relative);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, contents, "utf8");
	return target;
}

async function writeProject(relative: string, data: PackedProjectData): Promise<string> {
	return make(relative, JSON.stringify(data));
}

async function writeCurrentProject(relative: string, data: AxcutDocument): Promise<string> {
	return make(relative, JSON.stringify(data));
}

const readProject = async (file: string): Promise<PackedProjectData> =>
	JSON.parse(await fs.readFile(file, "utf8"));

const readCurrentProject = async (file: string): Promise<AxcutDocument> =>
	documentSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));

async function currentProject(options: { secondOriginalPath?: string } = {}) {
	const screenA = await make("recordings/a/session.mp4", "screen-a");
	const cameraA = await make("recordings/a/camera.mp4", "camera-a");
	await make("recordings/a/session.mp4.cursor.json", '[{"x":1}]');
	const screenB =
		options.secondOriginalPath ?? (await make("recordings/b/session.mp4", "screen-b"));
	await make("recordings/b/session.mp4.cursor.json", '[{"x":2}]');
	const base = createEmptyDocument({
		projectId: "project-1",
		title: "CLI fixture",
		createdAt: "2026-08-11T00:00:00.000Z",
	});
	return documentSchema.parse({
		...base,
		project: { ...base.project, primaryAssetId: "asset-a" },
		assets: [
			{
				id: "asset-a",
				kind: "video",
				label: "Screen A",
				originalPath: screenA,
				proxyPath: path.join(root, "cache", "a.proxy.mp4"),
				waveformPath: path.join(root, "cache", "a.waveform.json"),
				cameraTrack: {
					sourcePath: cameraA,
					startMs: 0,
					offsetMs: 25,
					visible: true,
				},
			},
			{
				id: "asset-b",
				kind: "video",
				label: "Screen B",
				originalPath: screenB,
				cameraTrack: null,
			},
		],
		timeline: {
			...base.timeline,
			clips: [
				{
					id: "clip-a",
					assetId: "asset-a",
					sourceStartSec: 0,
					sourceEndSec: 5,
					timelineStartSec: 0,
					timelineEndSec: 5,
					wordRefs: [],
					origin: "user",
					reason: "fixture",
				},
				{
					id: "clip-b",
					assetId: "asset-b",
					sourceStartSec: 0,
					sourceEndSec: 3,
					timelineStartSec: 5,
					timelineEndSec: 8,
					wordRefs: [],
					origin: "user",
					reason: "fixture",
				},
			],
		},
	});
}

/** Collects CLI output instead of writing to stdout. */
function recorder() {
	const chunks: string[] = [];
	const write = (text: string) => {
		chunks.push(text);
	};
	return { write, text: () => chunks.join("") };
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "os-cli-pack-"));
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("runPackCommand", () => {
	it("keeps screen and webcam apart when they share a basename", async () => {
		const screen = await make("rec/a/clip.mp4", "screen");
		const webcam = await make("rec/b/clip.mp4", "webcam");
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: screen, webcamVideoPath: webcam },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.media?.screenVideoPath).not.toBe(packed.media?.webcamVideoPath);
		await expect(fs.readFile(packed.media?.screenVideoPath ?? "", "utf8")).resolves.toBe("screen");
		await expect(fs.readFile(packed.media?.webcamVideoPath ?? "", "utf8")).resolves.toBe("webcam");
	});

	it("copies the cursor sidecar and drops the legacy videoPath", async () => {
		const screen = await make("rec/clip.mp4", "screen");
		await make("rec/clip.mp4.cursor.json", "[]");
		const project = await writeProject("demo.openscreen", { version: 1, videoPath: screen });
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, true, out.write)).toBe(0);

		const packed = await readProject(path.join(outDir, "demo.openscreen"));
		expect(packed.videoPath).toBeUndefined();
		expect(packed.media?.screenVideoPath).toBe(path.join(outDir, "clip.mp4"));
		await expect(fs.readFile(path.join(outDir, "clip.mp4.cursor.json"), "utf8")).resolves.toBe(
			"[]",
		);
		expect(JSON.parse(out.text())).toMatchObject({ event: "done", cursorData: true });
	});

	it("falls back to media sitting next to the project when the stored path is stale", async () => {
		await make("moved/clip.mp4", "screen");
		const project = await writeProject("moved/demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, false, out.write)).toBe(0);
		await expect(fs.readFile(path.join(outDir, "clip.mp4"), "utf8")).resolves.toBe("screen");
	});

	it("fails when the referenced media is nowhere to be found", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});

		const out = recorder();
		await expect(
			runPackCommand(project, path.join(root, "packed"), false, out.write),
		).rejects.toThrow(/Referenced media not found/);
	});

	it("packs every current-schema asset, camera track, and cursor sidecar", async () => {
		const document = await currentProject();
		const original = structuredClone(document);
		const project = await writeCurrentProject("demo.openscreen", document);
		const outDir = path.join(root, "packed");

		const out = recorder();
		expect(await runPackCommand(project, outDir, true, out.write)).toBe(0);

		const packed = await readCurrentProject(path.join(outDir, "demo.openscreen"));
		expect(document).toEqual(original);
		expect(packed.schemaVersion).toBe(7);
		expect(packed.project).toEqual(document.project);
		expect(packed.timeline.clips).toEqual(document.timeline.clips);
		expect(packed.assets.map((asset) => asset.id)).toEqual(["asset-a", "asset-b"]);
		expect(packed.assets[0].originalPath).toBe(path.join(outDir, "session.mp4"));
		expect(packed.assets[1].originalPath).toBe(path.join(outDir, "session-1.mp4"));
		expect(packed.assets[0].cameraTrack?.sourcePath).toBe(path.join(outDir, "camera.mp4"));
		expect(packed.assets[0].proxyPath).toBeUndefined();
		expect(packed.assets[0].waveformPath).toBeUndefined();
		await expect(fs.readFile(`${packed.assets[0].originalPath}.cursor.json`, "utf8")).resolves.toBe(
			'[{"x":1}]',
		);
		await expect(fs.readFile(`${packed.assets[1].originalPath}.cursor.json`, "utf8")).resolves.toBe(
			'[{"x":2}]',
		);
		expect(JSON.parse(out.text())).toMatchObject({
			event: "done",
			assetCount: 2,
			cursorData: true,
			droppedDerivedPaths: 2,
		});
	});
});

describe("runInfoCommand", () => {
	it("exits 1 when the project's video is missing, 0 when it is there", async () => {
		const missing = await writeProject("missing.openscreen", {
			version: 1,
			media: { screenVideoPath: path.join(root, "gone", "clip.mp4") },
		});
		const present = await writeProject("present.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
		});

		const out = recorder();
		expect(await runInfoCommand(missing, false, out.write)).toBe(1);
		expect(out.text()).toContain("[MISSING]");
		expect(await runInfoCommand(present, false, out.write)).toBe(0);
	});

	it("counts timeline regions in --json mode", async () => {
		const project = await writeProject("demo.openscreen", {
			version: 1,
			media: { screenVideoPath: await make("rec/clip.mp4") },
			editor: { zoomRegions: [{}, {}], trimRegions: [{}], exportFormat: "mp4" },
		});

		const out = recorder();
		expect(await runInfoCommand(project, true, out.write)).toBe(0);
		expect(JSON.parse(out.text())).toMatchObject({
			zoomRegions: 2,
			trimRegions: 1,
			speedRegions: 0,
			annotationRegions: 0,
			exportFormat: "mp4",
			screenVideoExists: true,
		});
	});

	it("reports current-schema projects and accepts media next to the project", async () => {
		const staleSecond = path.join(root, "old-location", "session-b.mp4");
		const document = await currentProject({ secondOriginalPath: staleSecond });
		await make("moved/session-b.mp4", "screen-b");
		const project = await writeCurrentProject("moved/demo.openscreen", document);

		const out = recorder();
		expect(await runInfoCommand(project, true, out.write)).toBe(0);
		expect(JSON.parse(out.text())).toMatchObject({
			projectPath: project,
			schemaVersion: 7,
			projectTitle: "CLI fixture",
			assetCount: 2,
			clipCount: 2,
			version: null,
			screenVideoPath: document.assets[0].originalPath,
			screenVideoExists: true,
			assets: [
				{
					id: "asset-a",
					originalPath: document.assets[0].originalPath,
					originalExists: true,
					cameraPath: document.assets[0].cameraTrack?.sourcePath,
					cameraExists: true,
				},
				{
					id: "asset-b",
					originalPath: staleSecond,
					resolvedOriginalPath: path.join(root, "moved", "session-b.mp4"),
					originalExists: true,
				},
			],
		});
	});

	it("exits 1 when any current-schema asset original is missing", async () => {
		const missingPath = path.join(root, "gone", "second.mp4");
		const document = await currentProject({ secondOriginalPath: missingPath });
		const project = await writeCurrentProject("demo.openscreen", document);

		const out = recorder();
		expect(await runInfoCommand(project, false, out.write)).toBe(1);
		expect(out.text()).toContain("Screen B");
		expect(out.text()).toContain("[MISSING]");
	});
});
