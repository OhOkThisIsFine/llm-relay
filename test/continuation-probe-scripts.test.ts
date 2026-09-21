import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptsDir = join(repoRoot, "scripts");
const helper = join(scriptsDir, "continuation-probe-lib.mjs");
const continuationScripts = readdirSync(scriptsDir)
  .filter(
    (name) =>
      name === "continuation-probe-lib.mjs" ||
      name === "measure-continuation-isolation.mjs" ||
      /^measure-(agy|claude|codex|opencode)-continuation\.mjs$/u.test(name),
  )
  .sort();

describe("continuation measurement scripts", () => {
  it("keeps the complete four-harness suite plus one shared helper", () => {
    expect(continuationScripts).toEqual([
      "continuation-probe-lib.mjs",
      "measure-agy-continuation.mjs",
      "measure-claude-continuation.mjs",
      "measure-codex-continuation.mjs",
      "measure-continuation-isolation.mjs",
      "measure-opencode-continuation.mjs",
    ]);
  });

  it.each(continuationScripts)("%s parses under the supported Node runtime", (name) => {
    const result = spawnSync(process.execPath, ["--check", join(scriptsDir, name)], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("redacts every harness identity form from failure diagnostics", () => {
    const requiredDist = join(repoRoot, "dist", "executable-lookup.js");
    expect(
      existsSync(requiredDist),
      "continuation-probe-lib.mjs imports dist/; run npm run build (the gate does) before this test",
    ).toBe(true);

    const sample = [
      '{"session_id":"123e4567-e89b-12d3-a456-426614174000"}',
      '{"thread_id":"223e4567-e89b-12d3-a456-426614174001"}',
      '{"conversation_id":"323e4567-e89b-12d3-a456-426614174002"}',
      '{"sessionID":"ses_abcDEF123-xyz"}',
      "OpenCode resumed ses_freeform456 but then failed",
      "Session 423e4567-e89b-12d3-a456-426614174003 was not found",
    ].join("\n");

    const program = [
      `import { redactProbeDiagnostics } from ${JSON.stringify(pathToFileURL(helper).href)};`,
      `process.stdout.write(redactProbeDiagnostics(${JSON.stringify(sample)}));`,
    ].join("\n");

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("123e4567-e89b-12d3-a456-426614174000");
    expect(result.stdout).not.toContain("223e4567-e89b-12d3-a456-426614174001");
    expect(result.stdout).not.toContain("323e4567-e89b-12d3-a456-426614174002");
    expect(result.stdout).not.toContain("423e4567-e89b-12d3-a456-426614174003");
    expect(result.stdout).not.toContain("ses_abcDEF123-xyz");
    expect(result.stdout).toContain('"session_id":"<redacted>"');
    expect(result.stdout).toContain('"thread_id":"<redacted>"');
    expect(result.stdout).toContain('"conversation_id":"<redacted>"');
    expect(result.stdout).toContain('"sessionID":"<redacted>"');
    expect(result.stdout).toContain("<redacted-id>");
    expect(result.stdout).toContain("ses_<redacted>");
  });
});
