import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { force: true, recursive: true });
	}
});

function executable(directory, name, source) {
	const executablePath = path.join(directory, name);
	fs.writeFileSync(executablePath, source, { mode: 0o755 });
	return executablePath;
}

function runBuild({ system, machine, enableCuda = "OFF", provideNvcc = false, args = [] }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-whisper-build-"));
	temporaryDirectories.push(root);
	const scriptDirectory = path.join(root, "scripts");
	const fakeBin = path.join(root, "fake-bin");
	const sourceDirectory = path.join(root, "electron", "native", "whisper-stt");
	fs.mkdirSync(scriptDirectory, { recursive: true });
	fs.mkdirSync(fakeBin, { recursive: true });
	fs.mkdirSync(sourceDirectory, { recursive: true });
	fs.copyFileSync(
		path.join(repoRoot, "scripts", "build-whisper-stt.sh"),
		path.join(scriptDirectory, "build-whisper-stt.sh"),
	);

	const logPath = path.join(root, "cmake.log");
	executable(
		fakeBin,
		"uname",
		`#!/usr/bin/env bash
if [[ "\${1:-}" == "-s" ]]; then
  printf '%s\\n' "\${FAKE_UNAME_SYSTEM}"
elif [[ "\${1:-}" == "-m" ]]; then
  printf '%s\\n' "\${FAKE_UNAME_MACHINE}"
else
  printf '%s\\n' "\${FAKE_UNAME_SYSTEM}"
fi
`,
	);
	executable(
		fakeBin,
		"cmake",
		`#!/usr/bin/env bash
{
  printf 'CALL\\n'
  printf 'ARG=%s\\n' "$@"
} >> "\${CMAKE_CAPTURE_LOG}"

if [[ "\${1:-}" == "--build" ]]; then
  exit 0
fi

build_dir=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-B" ]]; then
    build_dir="$2"
    break
  fi
  shift
done

if [[ "\${FAKE_UNAME_SYSTEM}" == MINGW* ]]; then
  mkdir -p "\${build_dir}/Release" "\${build_dir}/bin/Release"
  : > "\${build_dir}/Release/whisper-stt-server.exe"
  : > "\${build_dir}/bin/Release/ggml.dll"
else
  mkdir -p "\${build_dir}/bin"
  : > "\${build_dir}/whisper-stt-server"
  : > "\${build_dir}/bin/libggml.dylib"
fi
`,
	);
	if (provideNvcc) {
		executable(fakeBin, "nvcc", "#!/usr/bin/env bash\nexit 0\n");
	}

	const result = spawnSync("bash", [path.join(scriptDirectory, "build-whisper-stt.sh"), ...args], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			CMAKE_CAPTURE_LOG: logPath,
			ENABLE_CUDA: enableCuda,
			FAKE_UNAME_MACHINE: machine,
			FAKE_UNAME_SYSTEM: system,
			PATH: `${fakeBin}:${process.env.PATH}`,
			WHISPER_STT_BUILD_ROOT: path.join(root, "build-cache"),
		},
		stdio: "pipe",
	});

	const calls = fs.existsSync(logPath)
		? fs
				.readFileSync(logPath, "utf8")
				.split("CALL\n")
				.filter(Boolean)
				.map((call) =>
					call
						.split("\n")
						.filter((line) => line.startsWith("ARG="))
						.map((line) => line.slice("ARG=".length)),
				)
		: [];
	return { ...result, configureCalls: calls.filter((call) => call[0] === "-S") };
}

describe("whisper-stt CMake generator selection", () => {
	it("selects Visual Studio 2022 x64 explicitly on Windows", () => {
		const { configureCalls, status } = runBuild({
			system: "MINGW64_NT-10.0",
			machine: "x86_64",
		});
		expect(status).toBe(0);
		const [args] = configureCalls;
		expect(args).toEqual(expect.arrayContaining(["-G", "Visual Studio 17 2022", "-A", "x64"]));
	});

	it("leaves generator selection unchanged on Unix", () => {
		const { configureCalls, status } = runBuild({ system: "Darwin", machine: "x86_64" });
		expect(status).toBe(0);
		const [args] = configureCalls;
		expect(args).not.toContain("-G");
		expect(args).not.toContain("-A");
		expect(args).not.toContain("Visual Studio 17 2022");
		expect(args).not.toContain("x64");
	});

	it("builds both Windows variants when the workflow supplies ENABLE_CUDA=true", () => {
		const { configureCalls, status } = runBuild({
			system: "MINGW64_NT-10.0",
			machine: "x86_64",
			enableCuda: "true",
			provideNvcc: true,
		});
		expect(status).toBe(0);
		expect(configureCalls).toHaveLength(2);
		expect(configureCalls[0]).not.toContain("-DOSC_ENABLE_CUDA=ON");
		expect(configureCalls[1]).toContain("-DOSC_ENABLE_CUDA=ON");
		for (const args of configureCalls) {
			expect(args).toEqual(expect.arrayContaining(["-G", "Visual Studio 17 2022", "-A", "x64"]));
		}
	});

	it("keeps --cuda as an override for a false environment value", () => {
		const { configureCalls, status } = runBuild({
			system: "MINGW64_NT-10.0",
			machine: "x86_64",
			enableCuda: "false",
			provideNvcc: true,
			args: ["--cuda"],
		});
		expect(status).toBe(0);
		expect(configureCalls).toHaveLength(2);
		expect(configureCalls[1]).toContain("-DOSC_ENABLE_CUDA=ON");
	});

	it("rejects invalid ENABLE_CUDA values", () => {
		const { configureCalls, status, stderr } = runBuild({
			system: "MINGW64_NT-10.0",
			machine: "x86_64",
			enableCuda: "sometimes",
		});
		expect(status).toBe(2);
		expect(stderr).toContain("Invalid ENABLE_CUDA value: sometimes");
		expect(configureCalls).toHaveLength(0);
	});
});

describe("whisper-stt build workflow", () => {
	it("does not import a third-party MSVC environment action", () => {
		const workflowSource = fs.readFileSync(
			path.join(repoRoot, ".github", "workflows", "build-whisper-stt.yml"),
			"utf8",
		);
		const actions = [...workflowSource.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map(
			(match) => match[1],
		);
		expect(actions).not.toContain("ilammy/msvc-dev-cmd@v1");
	});
});
