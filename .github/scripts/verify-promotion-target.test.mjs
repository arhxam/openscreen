import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPromotionTarget } from "./verify-promotion-target.mjs";

const cleanup = [];

afterEach(() => {
	for (const dir of cleanup.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const git = (cwd, ...args) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function createFixture({ tagKind = "lightweight", advanceBranch = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "verify-promotion-target-"));
	cleanup.push(root);
	const remote = join(root, "remote.git");
	const source = join(root, "source");
	const checkout = join(root, "checkout");

	git(root, "init", "--bare", remote);
	git(root, "init", source);
	git(source, "config", "user.name", "Release Test");
	git(source, "config", "user.email", "release@example.com");
	writeFileSync(join(source, "release.txt"), "candidate\n");
	git(source, "add", "release.txt");
	git(source, "commit", "-m", "release candidate");
	git(source, "branch", "-M", "release/v2.0.0");
	if (tagKind === "annotated") {
		git(source, "tag", "-a", "v2.0.0-rc.1", "-m", "RC 1");
	} else {
		git(source, "tag", "v2.0.0-rc.1");
	}
	git(source, "remote", "add", "origin", remote);
	git(source, "push", "origin", "release/v2.0.0", "v2.0.0-rc.1");

	if (advanceBranch) {
		writeFileSync(join(source, "release.txt"), "untested cherry-pick\n");
		git(source, "add", "release.txt");
		git(source, "commit", "-m", "new release branch commit");
		git(source, "push", "origin", "release/v2.0.0");
	}

	git(root, "init", checkout);
	git(checkout, "remote", "add", "origin", remote);

	return { checkout, remote, source };
}

describe("verifyPromotionTarget", () => {
	it("accepts a lightweight RC tag at the release branch tip", () => {
		const { checkout } = createFixture();

		const result = verifyPromotionTarget({
			cwd: checkout,
			remote: "origin",
			rcTag: "v2.0.0-rc.1",
			releaseBranch: "release/v2.0.0",
		});

		expect(result.tagCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(result.branchCommit).toBe(result.tagCommit);
	});

	it("peels an annotated RC tag before comparing commits", () => {
		const { checkout } = createFixture({ tagKind: "annotated" });

		const result = verifyPromotionTarget({
			cwd: checkout,
			remote: "origin",
			rcTag: "v2.0.0-rc.1",
			releaseBranch: "release/v2.0.0",
		});

		expect(result.branchCommit).toBe(result.tagCommit);
	});

	it("rejects an untested release branch commit after the selected RC", () => {
		const { checkout } = createFixture({ advanceBranch: true });

		expect(() =>
			verifyPromotionTarget({
				cwd: checkout,
				remote: "origin",
				rcTag: "v2.0.0-rc.1",
				releaseBranch: "release/v2.0.0",
			}),
		).toThrow(/does not match.*release\/v2\.0\.0/i);
	});

	it("fails clearly when the selected RC tag does not exist", () => {
		const { checkout } = createFixture();

		expect(() =>
			verifyPromotionTarget({
				cwd: checkout,
				remote: "origin",
				rcTag: "v2.0.0-rc.99",
				releaseBranch: "release/v2.0.0",
			}),
		).toThrow(/fetch.*RC tag.*v2\.0\.0-rc\.99/i);
	});

	it("fails clearly when the release branch does not exist", () => {
		const { checkout } = createFixture();

		expect(() =>
			verifyPromotionTarget({
				cwd: checkout,
				remote: "origin",
				rcTag: "v2.0.0-rc.1",
				releaseBranch: "release/v2.0.1",
			}),
		).toThrow(/fetch.*release branch.*release\/v2\.0\.1/i);
	});

	it("detects a branch movement when verification is repeated", () => {
		const { checkout, source } = createFixture();
		const target = {
			cwd: checkout,
			remote: "origin",
			rcTag: "v2.0.0-rc.1",
			releaseBranch: "release/v2.0.0",
		};
		verifyPromotionTarget(target);

		writeFileSync(join(source, "release.txt"), "moved after initial verification\n");
		git(source, "add", "release.txt");
		git(source, "commit", "-m", "move branch after guard");
		git(source, "push", "origin", "release/v2.0.0");

		expect(() => verifyPromotionTarget(target)).toThrow(/does not match/i);
	});

	it("runs through the command line used by the promotion workflow", () => {
		const { checkout } = createFixture();
		const script = join(import.meta.dirname, "verify-promotion-target.mjs");

		const output = execFileSync("node", [script, "v2.0.0-rc.1", "release/v2.0.0", "origin"], {
			cwd: checkout,
			encoding: "utf8",
		});

		expect(output).toMatch(/Verified v2\.0\.0-rc\.1 and release\/v2\.0\.0 at [0-9a-f]{40}/);
	});
});
