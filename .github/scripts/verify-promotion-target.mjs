#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { argv } from "node:process";

function git(cwd, args) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function fetchRef({ cwd, remote, source, destination, description }) {
	try {
		git(cwd, ["fetch", "--force", "--no-tags", remote, `${source}:${destination}`]);
	} catch (error) {
		const detail = error.stderr?.toString().trim();
		throw new Error(
			`Could not fetch ${description} from ${remote}. Confirm that the ref exists and is reachable.${detail ? ` Git said: ${detail}` : ""}`,
		);
	}
}

/**
 * Fetch and compare the exact commits selected for a stable promotion.
 *
 * Fetching into dedicated local refs makes every invocation a fresh remote
 * check without changing the caller's working tree. The ^{commit} suffix
 * peels annotated tags while producing the same commit for lightweight tags.
 */
export function verifyPromotionTarget({
	cwd = process.cwd(),
	remote = "origin",
	rcTag,
	releaseBranch,
}) {
	if (!rcTag) throw new Error("an RC tag is required");
	if (!releaseBranch) throw new Error("a release branch is required");

	const tagRef = `refs/tags/${rcTag}`;
	const branchRef = `refs/heads/${releaseBranch}`;
	try {
		git(cwd, ["check-ref-format", tagRef]);
	} catch {
		throw new Error(`invalid RC tag ref: ${rcTag}`);
	}
	try {
		git(cwd, ["check-ref-format", branchRef]);
	} catch {
		throw new Error(`invalid release branch ref: ${releaseBranch}`);
	}

	const fetchedTagRef = "refs/openscreen-promotion/selected-rc";
	const fetchedBranchRef = `refs/remotes/${remote}/${releaseBranch}`;
	fetchRef({
		cwd,
		remote,
		source: tagRef,
		destination: fetchedTagRef,
		description: `RC tag ${rcTag}`,
	});
	fetchRef({
		cwd,
		remote,
		source: branchRef,
		destination: fetchedBranchRef,
		description: `release branch ${releaseBranch}`,
	});

	const tagCommit = git(cwd, ["rev-parse", "--verify", `${fetchedTagRef}^{commit}`]);
	const branchCommit = git(cwd, ["rev-parse", "--verify", `${fetchedBranchRef}^{commit}`]);
	if (tagCommit !== branchCommit) {
		throw new Error(
			`Selected RC tag ${rcTag} (${tagCommit}) does not match ${releaseBranch} (${branchCommit}); refusing to promote untested code`,
		);
	}

	return { tagCommit, branchCommit };
}

if (import.meta.filename === argv[1]) {
	const [rcTag, releaseBranch, remote = "origin"] = argv.slice(2);
	if (!rcTag || !releaseBranch) {
		console.error(
			"usage: node .github/scripts/verify-promotion-target.mjs <rc-tag> <release-branch> [remote]",
		);
		process.exit(1);
	}

	try {
		const { tagCommit } = verifyPromotionTarget({ rcTag, releaseBranch, remote });
		console.log(`Verified ${rcTag} and ${releaseBranch} at ${tagCommit}`);
	} catch (error) {
		console.error(`::error::${error.message}`);
		process.exit(1);
	}
}
