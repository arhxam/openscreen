import { z } from "zod";
import {
	type AxcutDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../../src/lib/ai-edition/schema";

export interface PackedProjectData {
	version?: number;
	media?: { screenVideoPath?: string; webcamVideoPath?: string; cursorCaptureMode?: string };
	videoPath?: string;
	editor?: Record<string, unknown>;
	[key: string]: unknown;
}

export type ProjectDocument =
	| { kind: "legacy"; document: PackedProjectData }
	| { kind: "current"; document: AxcutDocument };

const legacyMediaSchema = z
	.object({
		screenVideoPath: z.string().min(1).optional(),
		webcamVideoPath: z.string().min(1).optional(),
		cursorCaptureMode: z.string().optional(),
	})
	.passthrough();

const legacyProjectSchema = z
	.object({
		version: z.number().int().optional(),
		media: legacyMediaSchema.optional(),
		videoPath: z.string().min(1).optional(),
		editor: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

function issueSummary(error: z.ZodError): string {
	return error.issues
		.map(
			(issue) => `${issue.path.length > 0 ? issue.path.join(".") : "document"}: ${issue.message}`,
		)
		.join("; ");
}

/** Discriminates and validates every project document accepted by file-oriented CLI commands. */
export function parseProjectDocument(raw: unknown): ProjectDocument {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Unrecognized OpenScreen project document: expected a JSON object");
	}

	const record = raw as Record<string, unknown>;
	if ("schemaVersion" in record) {
		const version = record.schemaVersion;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 3 || version > 7) {
			throw new Error(
				`Unsupported Axcut schemaVersion ${String(version)}; supported versions are 3 through 7`,
			);
		}
		const parsed = documentSchema.safeParse(migrateRawDocumentToCurrent(raw));
		if (!parsed.success) {
			throw new Error(`Invalid Axcut project document: ${issueSummary(parsed.error)}`);
		}
		return { kind: "current", document: parsed.data };
	}

	const looksLegacy = ["version", "media", "videoPath", "editor"].some((key) => key in record);
	if (!looksLegacy) {
		throw new Error(
			"Unrecognized OpenScreen project document: expected schemaVersion or legacy version/media/editor fields",
		);
	}
	const parsed = legacyProjectSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`Invalid legacy OpenScreen project document: ${issueSummary(parsed.error)}`);
	}
	return { kind: "legacy", document: parsed.data };
}
