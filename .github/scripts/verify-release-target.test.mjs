import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { verifyReleaseTarget } from "./verify-release-target.mjs";

let repository;

function git(...args) {
	return execFileSync("git", args, {
		cwd: repository,
		encoding: "utf8",
	}).trim();
}

function commit(message) {
	writeFileSync(join(repository, "fixture.txt"), `${message}\n`);
	git("add", "fixture.txt");
	git("commit", "-m", message);
	return git("rev-parse", "HEAD");
}

beforeEach(() => {
	repository = mkdtempSync(join(tmpdir(), "verify-release-target-"));
	git("init", "--quiet");
	git("config", "user.email", "release-test@example.com");
	git("config", "user.name", "Release Test");
});

afterEach(() => {
	rmSync(repository, { recursive: true, force: true });
});

test("accepts a lightweight tag at the workflow commit", () => {
	const sha = commit("lightweight target");
	git("tag", "v1.9.2");

	assert.equal(verifyReleaseTarget("v1.9.2", sha, repository), sha);
});

test("peels an annotated tag before comparing it with the workflow commit", () => {
	const sha = commit("annotated target");
	git("tag", "-a", "v1.9.2", "-m", "release v1.9.2");

	assert.notEqual(git("rev-parse", "refs/tags/v1.9.2"), sha);
	assert.equal(verifyReleaseTarget("v1.9.2", sha, repository), sha);
});

test("accepts an annotated tag object's SHA as the workflow revision", () => {
	const sha = commit("annotated workflow revision");
	git("tag", "-a", "v1.9.2", "-m", "release v1.9.2");
	const tagObjectSha = git("rev-parse", "refs/tags/v1.9.2");

	assert.notEqual(tagObjectSha, sha);
	assert.equal(verifyReleaseTarget("v1.9.2", tagObjectSha, repository), sha);
});

test("runs directly the way the release workflow invokes it", () => {
	const sha = commit("direct invocation target");
	git("tag", "v1.9.2");

	const output = execFileSync(
		process.execPath,
		[join(import.meta.dirname, "verify-release-target.mjs"), "v1.9.2", sha],
		{ cwd: repository, encoding: "utf8" },
	);

	assert.match(output, new RegExp(`tag v1\\.9\\.2 targets workflow commit ${sha}`));
});

test("rejects a release tag that does not exist", () => {
	const sha = commit("untagged target");

	assert.throws(
		() => verifyReleaseTarget("v1.9.2", sha, repository),
		/tag v1\.9\.2 does not exist/,
	);
});

test("rejects a historical tag even when its version could match package.json", () => {
	const historicalSha = commit("historical release");
	git("tag", "v1.9.2");
	const workflowSha = commit("new main work with unchanged package version");

	assert.notEqual(historicalSha, workflowSha);
	assert.throws(
		() => verifyReleaseTarget("v1.9.2", workflowSha, repository),
		new RegExp(`tag v1\\.9\\.2 resolves to ${historicalSha}.*workflow is building ${workflowSha}`),
	);
});
