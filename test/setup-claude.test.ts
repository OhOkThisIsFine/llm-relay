import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getClaudeDesktopConfigPath, setupClaudeDesktop, setupClaudeCli } from "../src/setup-claude.js";

const dir = mkdtempSync(join(tmpdir(), "rp-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The developer's REAL Claude Desktop config, as it stood before this file ran.
 *
 * This suite used to call `setupClaudeDesktop()` with no arguments, and `SetupOptions` had no
 * way to redirect the write — `configDir` only ever changed the CLAUDE_CONFIG_DIR *value*
 * written into the file. So `npm test` reformatted a live application's settings file on
 * whatever machine it ran on. `targetPath` is the seam that fixes it; this is the guard that
 * keeps it fixed, because the failure is invisible from inside a passing test.
 */
const realPath = getClaudeDesktopConfigPath();
const realBefore = existsSync(realPath) ? statSync(realPath).mtimeMs : null;

afterAll(() => {
  const realAfter = existsSync(realPath) ? statSync(realPath).mtimeMs : null;
  expect(realAfter).toBe(realBefore);
});

describe("setup-claude", () => {
  it("getClaudeDesktopConfigPath returns platform path", () => {
    const p = getClaudeDesktopConfigPath();
    expect(p).toContain("Claude");
    expect(p.endsWith("claude_desktop_config.json")).toBe(true);
  });

  it("setupClaudeCli returns its lines and writes them through the injected sink", () => {
    const seen: string[] = [];
    const res = setupClaudeCli({ out: (l) => seen.push(l) });
    expect(res.success).toBe(true);
    expect(res.message).toBeDefined();
    // The sink got exactly what the caller was handed back — nothing went to stdout behind it.
    expect(seen).toEqual(res.lines);
    expect(res.lines.join("\n")).toContain("claude-proxied.ps1");
  });

  it("setupClaudeDesktop writes to the injected targetPath, not the real config", () => {
    const target = join(dir, "claude_desktop_config.json");
    const res = setupClaudeDesktop({ targetPath: target, proxyUrl: "http://127.0.0.1:9999" });

    expect(res.success).toBe(true);
    expect(res.path).toBe(target);
    expect(res.path).not.toBe(realPath);

    const written = JSON.parse(readFileSync(target, "utf8")) as { env: Record<string, string> };
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999");
    expect(written.env.CLAUDE_CONFIG_DIR).toBeDefined();
  });

  it("patches an existing config in place instead of replacing it", () => {
    const target = join(dir, "existing.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { keepme: {} }, env: { KEEP: "yes" } }, null, 2));

    const res = setupClaudeDesktop({ targetPath: target });
    expect(res.success).toBe(true);

    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: Record<string, unknown>;
      env: Record<string, string>;
    };
    // Unrelated settings survive, and so does an unrelated env var — this function edits a
    // file that belongs to another application, so anything it does not own must be left alone.
    expect(written.mcpServers.keepme).toBeDefined();
    expect(written.env.KEEP).toBe("yes");
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8791");
  });

  it("reports failure instead of throwing when the target cannot be written", () => {
    // Parent path is an existing FILE, so creating the directory fails. The caller gets a
    // result, not an exception — `llm-relay setup` prints `res.message` and must not stack-trace.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const res = setupClaudeDesktop({ targetPath: join(blocker, "claude_desktop_config.json") });
    expect(res.success).toBe(false);
    expect(res.message).toContain("Failed to configure Claude Desktop");
  });
});
