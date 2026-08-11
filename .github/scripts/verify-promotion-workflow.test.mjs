import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(join(import.meta.dirname, "../workflows/promote.yml"), "utf8");

function stepSection(name, nextName) {
	const start = workflow.indexOf(`- name: ${name}`);
	const end = workflow.indexOf(`- name: ${nextName}`, start);
	if (start < 0 || end < 0) throw new Error(`Could not find workflow steps ${name} -> ${nextName}`);
	return workflow.slice(start, end);
}

describe("promotion workflow commit provenance", () => {
	it("publishes the bump commit as an output", () => {
		const bump = stepSection(
			"Bump the version to stable on the release branch",
			"Push stable tag on the verified promotion commit",
		);

		expect(bump).toMatch(/id:\s+bump/);
		expect(bump).toMatch(/BUMP_COMMIT=.*rev-parse.*HEAD\^\{commit\}/);
		expect(bump).toMatch(/commit=.*BUMP_COMMIT.*GITHUB_OUTPUT/);
		expect(bump).not.toContain("git commit --allow-empty -m");
		expect(bump.indexOf("git push")).toBeLessThan(bump.indexOf("GITHUB_OUTPUT"));
	});

	it("tags the captured bump commit without refreshing the branch", () => {
		const stableTag = stepSection(
			"Push stable tag on the verified promotion commit",
			"Trigger build workflow",
		);

		expect(stableTag).toContain("BUMP_COMMIT: ${{ steps.bump.outputs.commit }}");
		expect(stableTag).toMatch(/git rev-parse --verify.*BUMP_COMMIT.*\^\{commit\}/);
		expect(stableTag).toContain("The verified stable bump commit is missing or invalid");
		expect(stableTag).toContain('git tag "$STABLE_TAG" "$BUMP_COMMIT"');
		expect(stableTag).toContain('git push origin ":${STABLE_TAG}" 2>/dev/null || true');
		expect(stableTag).not.toMatch(/git fetch|git reset|git checkout/);
	});
});
