// The two CLI commands that only touch the project file and its media:
// `openscreen pack` and `openscreen info`. They live outside cliMain.ts so they
// carry no `electron` import and stay unit-testable — the caller passes the
// writer, so nothing here knows about process.stdout either.

import fs from "node:fs/promises";
import path from "node:path";
import {
	type PackedProjectData,
	type ProjectDocument,
	parseProjectDocument,
} from "./projectDocument";

export type { PackedProjectData } from "./projectDocument";

/** Writes one already-newline-terminated chunk of CLI output. */
export type CliWriter = (text: string) => void;

const isFile = (candidate: string): Promise<boolean> =>
	fs
		.stat(candidate)
		.then((stats) => stats.isFile())
		.catch(() => false);

interface ResolvedReference {
	storedPath: string;
	resolvedPath: string | null;
	exists: boolean;
}

/** Applies the same moved-project sibling fallback used by the desktop loader. */
async function resolveReference(
	projectDir: string,
	storedPath: string,
): Promise<ResolvedReference> {
	if (await isFile(storedPath)) {
		return { storedPath, resolvedPath: storedPath, exists: true };
	}
	const sibling = path.join(projectDir, path.basename(storedPath));
	if (await isFile(sibling)) {
		return { storedPath, resolvedPath: sibling, exists: true };
	}
	return { storedPath, resolvedPath: null, exists: false };
}

async function readProject(projectPath: string): Promise<ProjectDocument> {
	let raw: unknown;
	try {
		raw = JSON.parse(await fs.readFile(projectPath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Invalid project JSON: ${error.message}`);
		}
		throw error;
	}
	return parseProjectDocument(raw);
}

interface BundleCopier {
	copy(sourcePath: string): Promise<string>;
	copyOriginal(sourcePath: string): Promise<{ destination: string; cursorSidecarCopied: boolean }>;
	files(): string[];
}

function portableDestinationKey(candidate: string): string {
	// A bundle can be created on a case-sensitive filesystem and opened on a
	// case-insensitive one. Reserve names using the stricter portable semantics.
	return path.resolve(candidate).normalize("NFC").toLowerCase();
}

async function sourceIdentity(sourcePath: string): Promise<string> {
	const realPath = await fs.realpath(sourcePath);
	const normalized = realPath.normalize("NFC");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function createBundleCopier(outDir: string, reservedPaths: string[]): BundleCopier {
	const copied: string[] = [];
	const destinationSet = new Set(reservedPaths.map(portableDestinationKey));
	const sourceDestinations = new Map<string, string>();

	const reserveDestination = (
		sourcePath: string,
		includeCursorSidecar: boolean,
	): { destination: string; cursorDestination: string | null } => {
		const ext = path.extname(sourcePath);
		const stem = path.basename(sourcePath, ext);
		for (let n = 0; ; n++) {
			const destination = path.join(outDir, `${stem}${n === 0 ? "" : `-${n}`}${ext}`);
			const cursorDestination = includeCursorSidecar ? `${destination}.cursor.json` : null;
			if (
				!destinationSet.has(portableDestinationKey(destination)) &&
				(!cursorDestination || !destinationSet.has(portableDestinationKey(cursorDestination)))
			) {
				destinationSet.add(portableDestinationKey(destination));
				if (cursorDestination) {
					destinationSet.add(portableDestinationKey(cursorDestination));
				}
				return { destination, cursorDestination };
			}
		}
	};

	const copyMedia = async (
		sourcePath: string,
		withCursorSidecar: boolean,
	): Promise<{ destination: string; cursorSidecarCopied: boolean }> => {
		const sourceKey = await sourceIdentity(sourcePath);
		const existing = sourceDestinations.get(sourceKey);
		if (existing) return { destination: existing, cursorSidecarCopied: false };
		const cursorSource = `${sourcePath}.cursor.json`;
		const hasCursorSidecar = withCursorSidecar && (await isFile(cursorSource));
		const { destination, cursorDestination } = reserveDestination(sourcePath, hasCursorSidecar);
		if (path.resolve(sourcePath) !== path.resolve(destination)) {
			await fs.copyFile(sourcePath, destination);
		}
		if (cursorDestination) {
			await fs.copyFile(cursorSource, cursorDestination);
		}
		sourceDestinations.set(sourceKey, destination);
		copied.push(destination);
		if (cursorDestination) copied.push(cursorDestination);
		return { destination, cursorSidecarCopied: cursorDestination !== null };
	};

	return {
		async copy(sourcePath) {
			return (await copyMedia(sourcePath, false)).destination;
		},
		async copyOriginal(sourcePath) {
			return copyMedia(sourcePath, true);
		},
		files: () => [...copied],
	};
}

/** Copies a project and everything it references into one portable folder. */
export async function runPackCommand(
	projectPath: string,
	outDir: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const emit = (message: string) => {
		if (!json) out(`${message}\n`);
	};
	const loaded = await readProject(projectPath);
	const projectDir = path.dirname(path.resolve(projectPath));
	await fs.mkdir(outDir, { recursive: true });
	const packedProjectPath = path.join(outDir, path.basename(projectPath));
	const copier = createBundleCopier(outDir, [packedProjectPath]);
	let cursorSidecars = 0;
	let assetCount = 1;
	let droppedDerivedPaths = 0;
	let packedProject: PackedProjectData | ProjectDocument["document"];

	if (loaded.kind === "legacy") {
		const data = loaded.document;
		const media = data.media ?? (data.videoPath ? { screenVideoPath: data.videoPath } : undefined);
		const screenVideoPath = media?.screenVideoPath;
		if (!screenVideoPath) {
			throw new Error("Project file does not reference a screen video");
		}
		const screenReference = await resolveReference(projectDir, screenVideoPath);
		if (!screenReference.resolvedPath) {
			throw new Error(`Referenced media not found: ${screenVideoPath}`);
		}
		const bundledScreen = await copier.copyOriginal(screenReference.resolvedPath);
		const newScreenPath = bundledScreen.destination;

		let newWebcamPath: string | undefined;
		if (media.webcamVideoPath) {
			const webcamReference = await resolveReference(projectDir, media.webcamVideoPath);
			if (!webcamReference.resolvedPath) {
				throw new Error(`Referenced media not found: ${media.webcamVideoPath}`);
			}
			newWebcamPath = await copier.copy(webcamReference.resolvedPath);
		}
		if (bundledScreen.cursorSidecarCopied) cursorSidecars++;

		packedProject = {
			...data,
			media: {
				...media,
				screenVideoPath: newScreenPath,
				...(newWebcamPath ? { webcamVideoPath: newWebcamPath } : {}),
			},
		};
		delete packedProject.videoPath;
	} else {
		assetCount = loaded.document.assets.length;
		const references = [];
		for (const asset of loaded.document.assets) {
			const originalReference = await resolveReference(projectDir, asset.originalPath);
			if (!originalReference.resolvedPath) {
				throw new Error(`Referenced media not found: ${asset.originalPath}`);
			}
			let resolvedCameraPath: string | null = null;
			if (asset.cameraTrack) {
				const cameraReference = await resolveReference(projectDir, asset.cameraTrack.sourcePath);
				if (!cameraReference.resolvedPath) {
					throw new Error(`Referenced media not found: ${asset.cameraTrack.sourcePath}`);
				}
				resolvedCameraPath = cameraReference.resolvedPath;
			}
			references.push({ asset, originalPath: originalReference.resolvedPath, resolvedCameraPath });
		}

		// Originals reserve their optional cursor partner before cameras consume any names.
		const originals = [];
		for (const reference of references) {
			const bundled = await copier.copyOriginal(reference.originalPath);
			if (bundled.cursorSidecarCopied) cursorSidecars++;
			originals.push(bundled.destination);
		}

		const assets = [];
		for (const [index, reference] of references.entries()) {
			const { asset } = reference;
			const cameraTrack =
				asset.cameraTrack && reference.resolvedCameraPath
					? {
							...asset.cameraTrack,
							sourcePath: await copier.copy(reference.resolvedCameraPath),
						}
					: asset.cameraTrack;

			const { proxyPath, waveformPath, ...portableAsset } = asset;
			droppedDerivedPaths += Number(proxyPath !== undefined) + Number(waveformPath !== undefined);
			assets.push({
				...portableAsset,
				originalPath: originals[index],
				cameraTrack,
			});
		}
		// Proxy and waveform paths are derived caches, not required source media.
		// Dropping them prevents a moved bundle from retaining machine-local cache paths.
		packedProject = { ...loaded.document, assets };
	}

	await fs.writeFile(packedProjectPath, JSON.stringify(packedProject, null, 2), "utf8");
	const copied = copier.files();

	if (json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				projectPath: packedProjectPath,
				files: [packedProjectPath, ...copied],
				cursorData: cursorSidecars > 0,
				cursorSidecars,
				assetCount,
				droppedDerivedPaths,
			})}\n`,
		);
	} else {
		emit(`Packed project → ${packedProjectPath}`);
		for (const file of copied) emit(`  + ${path.basename(file)}`);
		if (cursorSidecars === 0) emit("  (no cursor telemetry sidecar found)");
		if (droppedDerivedPaths > 0) {
			emit(`  (removed ${droppedDerivedPaths} derived proxy/waveform cache paths)`);
		}
		emit(
			"The folder is self-contained: if the stored paths go stale after moving it, the loader falls back to files next to the project.",
		);
	}
	return 0;
}

async function legacyInfo(projectPath: string, data: PackedProjectData) {
	const editor = data.editor ?? {};
	const count = (key: string) =>
		Array.isArray(editor[key]) ? (editor[key] as unknown[]).length : 0;
	const projectDir = path.dirname(path.resolve(projectPath));
	const screenVideoPath = data.media?.screenVideoPath ?? data.videoPath ?? null;
	const screenReference = screenVideoPath
		? await resolveReference(projectDir, screenVideoPath)
		: null;
	return {
		projectPath,
		version: data.version ?? null,
		screenVideoPath,
		screenVideoExists: screenReference?.exists ?? false,
		resolvedScreenVideoPath: screenReference?.resolvedPath ?? null,
		webcamVideoPath: data.media?.webcamVideoPath ?? null,
		cursorCaptureMode: data.media?.cursorCaptureMode ?? null,
		exportFormat: (editor.exportFormat as string) ?? null,
		exportQuality: (editor.exportQuality as string) ?? null,
		aspectRatio: (editor.aspectRatio as string) ?? null,
		zoomRegions: count("zoomRegions"),
		trimRegions: count("trimRegions"),
		speedRegions: count("speedRegions"),
		annotationRegions: count("annotationRegions"),
	};
}

/** Prints what a project references and whether its media is still reachable. */
export async function runInfoCommand(
	projectPath: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const loaded = await readProject(projectPath);
	if (loaded.kind === "legacy") {
		const summary = await legacyInfo(projectPath, loaded.document);
		if (json) {
			out(`${JSON.stringify(summary)}\n`);
		} else {
			out(
				[
					`Project:  ${summary.projectPath} (version ${summary.version ?? "?"})`,
					`Video:    ${summary.screenVideoPath ?? "(none)"}${summary.screenVideoExists ? "" : "  [MISSING]"}`,
					`Webcam:   ${summary.webcamVideoPath ?? "(none)"}`,
					`Cursor:   ${summary.cursorCaptureMode ?? "(unknown)"}`,
					`Export:   ${summary.exportFormat ?? "?"} / ${summary.exportQuality ?? "?"} / ${summary.aspectRatio ?? "?"}`,
					`Timeline: ${summary.zoomRegions} zooms, ${summary.trimRegions} trims, ${summary.speedRegions} speed regions, ${summary.annotationRegions} annotations`,
				].join("\n") + "\n",
			);
		}
		return summary.screenVideoPath && !summary.screenVideoExists ? 1 : 0;
	}

	const document = loaded.document;
	const projectDir = path.dirname(path.resolve(projectPath));
	const assets = await Promise.all(
		document.assets.map(async (asset) => {
			const original = await resolveReference(projectDir, asset.originalPath);
			const camera = asset.cameraTrack
				? await resolveReference(projectDir, asset.cameraTrack.sourcePath)
				: null;
			return {
				id: asset.id,
				label: asset.label,
				originalPath: asset.originalPath,
				resolvedOriginalPath: original.resolvedPath,
				originalExists: original.exists,
				cameraPath: asset.cameraTrack?.sourcePath ?? null,
				resolvedCameraPath: camera?.resolvedPath ?? null,
				cameraExists: camera?.exists ?? null,
			};
		}),
	);
	const primaryId = document.project.primaryAssetId ?? document.assets[0]?.id;
	const primaryIndex = primaryId
		? document.assets.findIndex((asset) => asset.id === primaryId)
		: -1;
	const primaryAsset = primaryIndex >= 0 ? document.assets[primaryIndex] : undefined;
	const primaryStatus = primaryIndex >= 0 ? assets[primaryIndex] : undefined;
	const legacyEditor = document.legacyEditor ?? {};
	const summary = {
		projectPath,
		schemaVersion: document.schemaVersion,
		projectTitle: document.project.title,
		assetCount: document.assets.length,
		clipCount: document.timeline.clips.length,
		assets,
		// Keep the established JSON fields populated for current projects where they map cleanly.
		version: null,
		screenVideoPath: primaryAsset?.originalPath ?? null,
		screenVideoExists: primaryStatus?.originalExists ?? false,
		webcamVideoPath: primaryAsset?.cameraTrack?.sourcePath ?? null,
		cursorCaptureMode: null,
		exportFormat: (legacyEditor.exportFormat as string) ?? null,
		exportQuality: (legacyEditor.exportQuality as string) ?? null,
		aspectRatio: (legacyEditor.aspectRatio as string) ?? null,
		zoomRegions: document.zoomRanges.length,
		trimRegions: document.timeline.trimRanges.length,
		speedRegions: document.timeline.speedRanges.length,
		annotationRegions: document.annotations.length,
	};

	if (json) {
		out(`${JSON.stringify(summary)}\n`);
	} else {
		const lines = [
			`Project:  ${summary.projectPath} (${summary.projectTitle}, schema ${summary.schemaVersion})`,
			`Assets:   ${summary.assetCount}`,
		];
		for (const asset of assets) {
			lines.push(
				`  ${asset.label}: ${asset.originalPath}${asset.originalExists ? "" : "  [MISSING]"}`,
			);
			if (asset.cameraPath) {
				lines.push(`    Camera: ${asset.cameraPath}${asset.cameraExists ? "" : "  [MISSING]"}`);
			}
		}
		lines.push(
			`Timeline: ${summary.clipCount} clips, ${summary.zoomRegions} zooms, ${summary.trimRegions} trims, ${summary.speedRegions} speed regions, ${summary.annotationRegions} annotations`,
		);
		out(`${lines.join("\n")}\n`);
	}
	return assets.some(
		(asset) => !asset.originalExists || (asset.cameraPath !== null && !asset.cameraExists),
	)
		? 1
		: 0;
}
