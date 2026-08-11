import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"stage-whisper-stt.sh",
);
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function makeFakeGh(directory) {
	const binDirectory = path.join(directory, "bin");
	fs.mkdirSync(binDirectory);
	const fakeGh = path.join(binDirectory, "gh");
	fs.writeFileSync(
		fakeGh,
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_GH_LOG}"

if [ "$1 $2" = "run list" ]; then
  printf '%s' "\${FAKE_GH_RUNS:-}"
  exit 0
fi

if [ "$1 $2" = "run download" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) artifact_dir="$2"; shift 2 ;;
      --name) artifact_name="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  payload="\${artifact_dir}/payload/\${artifact_name}"
  mkdir -p "\${payload}"
  printf '%s\\n' '#!/bin/sh' 'echo "[whisper-stt] boot: fake"' 'exit 1' > "\${payload}/whisper-stt-server"
  chmod +x "\${payload}/whisper-stt-server"
  tar -czf "\${artifact_dir}/\${artifact_name}.tar.gz" -C "\${artifact_dir}/payload" "\${artifact_name}"
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 2
`,
	);
	fs.chmodSync(fakeGh, 0o755);
	return binDirectory;
}

function runStage({ sha, runs = "", prebuilt = false } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage-whisper-stt-test-"));
	temporaryDirectories.push(directory);
	if (prebuilt) {
		const destination = path.join(directory, "electron/native/bin/darwin-x64");
		fs.mkdirSync(destination, { recursive: true });
		fs.writeFileSync(path.join(destination, "whisper-stt-server"), "local binary");
	}
	const log = path.join(directory, "gh.log");
	const binDirectory = makeFakeGh(directory);
	const env = {
		...process.env,
		PATH: `${binDirectory}:${process.env.PATH}`,
		FAKE_GH_LOG: log,
		FAKE_GH_RUNS: runs,
		GITHUB_REPOSITORY: "example/openscreen",
	};
	if (sha === undefined) delete env.GITHUB_SHA;
	else env.GITHUB_SHA = sha;

	try {
		const stdout = execFileSync("bash", [script, "darwin-x64"], {
			cwd: directory,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			status: 0,
			stdout,
			stderr: "",
			log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
		};
	} catch (error) {
		return {
			status: error.status,
			stdout: error.stdout?.toString() ?? "",
			stderr: error.stderr?.toString() ?? "",
			log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "",
		};
	}
}

describe("stage-whisper-stt artifact provenance", () => {
	it("keeps a local prebuilt binary without requiring GitHub metadata", () => {
		const result = runStage({ prebuilt: true });

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /already present/);
		assert.equal(result.log, "");
	});

	it("downloads the successful workflow run for the exact build commit", () => {
		const result = runStage({
			sha: "exact-sha",
			runs: "900\tnewer-wrong-sha\tsuccess\n123\texact-sha\tsuccess\n",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.log, /run list --repo example\/openscreen --workflow build-whisper-stt\.yml/);
		assert.match(result.log, /--commit exact-sha --status success/);
		const download = result.log.split("\n").find((line) => line.startsWith("run download"));
		assert.match(
			download ?? "",
			/^run download 123 --repo example\/openscreen --name whisper-stt-darwin-x64 --dir \/.+/,
		);
	});

	it("ignores unsuccessful runs for the exact commit", () => {
		const result = runStage({
			sha: "exact-sha",
			runs: "200\texact-sha\tfailure\n100\texact-sha\tsuccess\n",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.match(result.log, /run download 100 --repo example\/openscreen/);
	});

	it("fails clearly when GITHUB_SHA is missing", () => {
		const result = runStage();

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /GITHUB_SHA/);
		assert.doesNotMatch(result.log, /run download/);
	});

	it("fails when no successful run has the exact commit", () => {
		const result = runStage({
			sha: "exact-sha",
			runs: "300\texact-sha\tfailure\n200\twrong-sha\tsuccess\n",
		});

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /no successful build-whisper-stt run/);
		assert.match(result.stderr, /exact-sha/);
		assert.doesNotMatch(result.log, /run download/);
	});
});
