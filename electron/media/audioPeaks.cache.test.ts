// @vitest-environment node
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
	spawn: vi.fn(),
	userData: "",
}));

vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("electron", () => ({
	app: {
		getAppPath: () => null,
		getPath: () => mocked.userData,
	},
}));

import { audioPeakCacheKey, getAudioPeaks } from "./audioPeaks";

describe("getAudioPeaks disk cache", () => {
	let root: string;
	let previousFfmpegPath: string | undefined;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "openscreen-audio-peak-cache-"));
		mocked.userData = path.join(root, "user-data");
		previousFfmpegPath = process.env.OPENSCREEN_FFMPEG_PATH;
		const ffmpeg = path.join(root, "ffmpeg");
		await writeFile(ffmpeg, "");
		await chmod(ffmpeg, 0o755);
		process.env.OPENSCREEN_FFMPEG_PATH = ffmpeg;
	});

	afterEach(async () => {
		mocked.spawn.mockReset();
		if (previousFfmpegPath === undefined) {
			delete process.env.OPENSCREEN_FFMPEG_PATH;
		} else {
			process.env.OPENSCREEN_FFMPEG_PATH = previousFfmpegPath;
		}
		await rm(root, { recursive: true, force: true });
	});

	it("decodes and overwrites a cached buffer with the wrong byte length", async () => {
		const mediaPath = path.join(root, "recording.mp4");
		await writeFile(mediaPath, "media fixture");
		const durationSec = 0.005;
		const info = await stat(mediaPath);
		const key = audioPeakCacheKey(
			{ filePath: mediaPath, size: info.size, mtimeMs: info.mtimeMs },
			durationSec,
		);
		const cachePath = path.join(mocked.userData, "audio-peaks", `${key}.f32`);
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, Buffer.alloc(1));

		mocked.spawn.mockImplementation(() => {
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter;
				stderr: EventEmitter;
				kill: ReturnType<typeof vi.fn>;
			};
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.kill = vi.fn();
			queueMicrotask(() => {
				const pcm = Buffer.alloc(4);
				pcm.writeInt16LE(-32_768, 0);
				pcm.writeInt16LE(16_384, 2);
				child.stdout.emit("data", pcm);
				child.emit("close", 0);
			});
			return child;
		});

		const peaks = await getAudioPeaks(mediaPath, durationSec);

		expect(mocked.spawn).toHaveBeenCalledOnce();
		expect(peaks).toEqual(new Float32Array([-1, 0.5]));
		const rewritten = await readFile(cachePath);
		expect(rewritten.byteLength).toBe(2 * Float32Array.BYTES_PER_ELEMENT);
		expect(new Float32Array(Uint8Array.from(rewritten).buffer)).toEqual(peaks);
	});
});
