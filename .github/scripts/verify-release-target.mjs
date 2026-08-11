#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { argv } from "node:process";

function tagCommit(tag, cwd) {
	try {
		return execFileSync("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		throw new Error(`release tag ${tag} does not exist or does not point to a commit`);
	}
}

/**
 * Verify that the release named by `tag` belongs to the commit whose artifacts
 * this workflow built. The ^{commit} peel handles both lightweight and
 * annotated tags without comparing an annotated tag object's SHA by mistake.
 *
 * @param {string} tag Release tag, e.g. v1.9.2 or v1.9.2-rc.1.
 * @param {string} expectedSha The current workflow's GITHUB_SHA.
 * @param {string} cwd Repository containing the fetched release tag.
 * @returns {string} The resolved commit SHA.
 */
export function verifyReleaseTarget(tag, expectedSha, cwd = process.cwd()) {
	if (!tag) throw new Error("a release tag is required");
	if (!expectedSha) throw new Error("the workflow commit SHA is required");

	const resolvedSha = tagCommit(tag, cwd);
	if (resolvedSha.toLowerCase() !== expectedSha.toLowerCase()) {
		throw new Error(
			`release tag ${tag} resolves to ${resolvedSha}, but this workflow is building ${expectedSha}; refusing to replace another commit's release assets`,
		);
	}

	return resolvedSha;
}

if (import.meta.filename === argv[1]) {
	try {
		const resolvedSha = verifyReleaseTarget(argv[2], argv[3]);
		console.log(`release tag ${argv[2]} targets workflow commit ${resolvedSha}`);
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
